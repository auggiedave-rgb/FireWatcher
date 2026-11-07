/* FireWatch – global active fires on a 3D globe (CesiumJS + NASA FIRMS + NASA GIBS) */
'use strict';

// ---------- Config ----------
const API = '/api/fires';
const SOURCES = {
  VIIRS_NOAA20_NRT: 'VIIRS NOAA-20',
  VIIRS_NOAA21_NRT: 'VIIRS NOAA-21',
  VIIRS_SNPP_NRT: 'VIIRS Suomi NPP',
  MODIS_NRT: 'MODIS Terra/Aqua',
};
const REGIONS = {
  italy: { label: 'Italy', bbox: [6.5, 35.3, 18.7, 47.2], country: 'Italy' },
  europe: { label: 'Europe', bbox: [-25, 34, 45, 72] },
  world: { label: 'World', bbox: null },
};
const FRP_STEPS = [0, 2, 5, 10, 25, 50, 100];
const CONF_LABEL = ['Low', 'Nominal', 'High'];
const REFRESH_MS = 15 * 60 * 1000;
const COUNTRIES_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_admin_0_countries.geojson';
const BORDERS_URL = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_admin_0_boundary_lines_land.geojson';
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg4326/best';

// ---------- State ----------
const saved = (() => { try { return JSON.parse(localStorage.getItem('fw-settings') || '{}'); } catch { return {}; } })();
const state = Object.assign({
  range: 24,
  sources: ['VIIRS_NOAA20_NRT'],
  minConf: 1,
  frpStep: 0,
  colorBy: 'age',
  region: 'italy',
  base: 'bluemarble',
  night: true,
  borders: true,
}, saved);
const save = () => { try { localStorage.setItem('fw-settings', JSON.stringify(state)); } catch { /* private mode */ } };

const dayCache = new Map(); // `${source}|${date}` -> {fetchedAt, points: [...]}
let visible = [];            // currently drawn points
let lastLoadError = null;

// ---------- Helpers ----------
const $ = (s) => document.querySelector(s);
const utcDate = (offset) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10);
const fmtAge = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ${h % 24} h ago`;
};
const fmtUtc = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const fmtLocal = (t) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtCoord = (lat, lon) => `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
function toast(msg, ms = 6000) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (el.hidden = true), ms);
}

// ---------- Globe ----------
Cesium.Ion.defaultAccessToken = undefined; // no Cesium ion services are used

const tiling = new Cesium.GeographicTilingScheme();
function gibsProvider(layer, { time = 'default', matrixSet = '500m', ext = 'jpg', maxLevel = 7 } = {}) {
  return new Cesium.WebMapTileServiceImageryProvider({
    url: `${GIBS}/${layer}/default/${time}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.${ext}`,
    layer, style: 'default', format: ext === 'png' ? 'image/png' : 'image/jpeg',
    tileMatrixSetID: matrixSet, tilingScheme: tiling, tileWidth: 512, tileHeight: 512,
    maximumLevel: maxLevel, credit: new Cesium.Credit('NASA GIBS'),
  });
}
const baseProvider = (key) => key === 'bluemarble'
  ? gibsProvider('BlueMarble_ShadedRelief_Bathymetry', { maxLevel: 7 })
  : gibsProvider('VIIRS_NOAA20_CorrectedReflectance_TrueColor', { time: key.slice(3), matrixSet: '250m', maxLevel: 8 });

const viewer = new Cesium.Viewer('globe', {
  baseLayer: new Cesium.ImageryLayer(baseProvider(state.base)),
  terrainProvider: new Cesium.EllipsoidTerrainProvider(),
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
  infoBox: false, selectionIndicator: false,
  requestRenderMode: true, maximumRenderTimeChange: Infinity,
  msaaSamples: 1,
});
const scene = viewer.scene;
const globe = scene.globe;
viewer.clock.shouldAnimate = false;
viewer.clock.currentTime = Cesium.JulianDate.now();
globe.baseColor = Cesium.Color.fromCssColorString('#0a1a2e');
globe.showGroundAtmosphere = true;
globe.atmosphereLightIntensity = 12;
globe.maximumScreenSpaceError = 1.5;
scene.fog.enabled = false;
scene.screenSpaceCameraController.minimumZoomDistance = 30000;     // ~30 km: regional zoom, not street level
scene.screenSpaceCameraController.maximumZoomDistance = 40000000;
viewer.resolutionScale = Math.min(window.devicePixelRatio || 1, 2);

let nightLayer = null;
function applyNight() {
  globe.enableLighting = state.night;
  globe.dynamicAtmosphereLighting = state.night;
  if (state.night && !nightLayer) {
    nightLayer = viewer.imageryLayers.addImageryProvider(gibsProvider('VIIRS_Black_Marble', { ext: 'png', maxLevel: 7 }));
    nightLayer.dayAlpha = 0.0;
    nightLayer.nightAlpha = 1.0;
    nightLayer.brightness = 1.6;
  } else if (!state.night && nightLayer) {
    viewer.imageryLayers.remove(nightLayer, true); nightLayer = null;
  }
  scene.requestRender();
}
function applyBase() {
  const layers = viewer.imageryLayers;
  const old = layers.get(0);
  const nl = new Cesium.ImageryLayer(baseProvider(state.base));
  layers.add(nl, 0);
  layers.remove(old, true);
  scene.requestRender();
}

// Country borders (vector) and country lookup polygons
let bordersDs = null;
async function applyBorders() {
  if (state.borders && !bordersDs) {
    try {
      bordersDs = await Cesium.GeoJsonDataSource.load(BORDERS_URL, {
        stroke: Cesium.Color.WHITE.withAlpha(0.45), strokeWidth: 1, clampToGround: false,
      });
      await viewer.dataSources.add(bordersDs);
    } catch (e) { console.warn('Borders unavailable', e); bordersDs = null; }
  }
  if (bordersDs) bordersDs.show = state.borders;
  scene.requestRender();
}

let countries = null; // [{name, bbox, polys:[[ring...]...]}]
async function loadCountries() {
  if (countries) return countries;
  try {
    const gj = await (await fetch(COUNTRIES_URL)).json();
    countries = gj.features.map((f) => {
      const g = f.geometry; const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      let bb = [180, 90, -180, -90];
      polys.forEach((p) => p[0].forEach(([x, y]) => { bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)]; }));
      return { name: f.properties.NAME || f.properties.ADMIN || f.properties.name, bbox: bb, polys };
    });
  } catch (e) { console.warn('Countries unavailable', e); countries = []; }
  return countries;
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function countryAt(lat, lon) {
  if (!countries) return null;
  let best = null; let bestD = 0.35; // allow ~35 km tolerance for coarse coastlines
  for (const c of countries) {
    const [w, s, e, n] = c.bbox;
    if (lon < w - 0.4 || lon > e + 0.4 || lat < s - 0.4 || lat > n + 0.4) continue;
    for (const p of c.polys) {
      if (inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h))) return c.name;
      for (const [x, y] of p[0]) { const d = Math.hypot(x - lon, y - lat); if (d < bestD) { bestD = d; best = c.name; } }
    }
  }
  return best;
}

// Fire points
const points = scene.primitives.add(new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.TRANSLUCENT }));
const AGE_COLORS = [
  [6, '#fff4a3', '< 6 h'], [24, '#ffb21e', '6–24 h'], [48, '#ff6a00', '1–2 days'], [96, '#e0301e', '2–4 days'], [Infinity, '#8f1d12', '> 4 days'],
];
const FRP_COLORS = [
  [5, '#ffe066', '< 5 MW'], [20, '#ffa62b', '5–20 MW'], [100, '#ff5a1f', '20–100 MW'], [500, '#d7191c', '100–500 MW'], [Infinity, '#ffffff', '> 500 MW'],
];
const colorCache = {};
const cesColor = (hex, a = 0.92) => (colorCache[hex + a] ||= Cesium.Color.fromCssColorString(hex).withAlpha(a));
const scaler = new Cesium.NearFarScalar(2.0e5, 1.3, 2.0e7, 0.55);
const OUTLINE = Cesium.Color.BLACK.withAlpha(0.35);

function pointStyle(p, now) {
  let hex;
  if (state.colorBy === 'age') {
    const h = (now - p.t) / 36e5;
    hex = AGE_COLORS.find(([lim]) => h < lim)[1];
  } else {
    hex = FRP_COLORS.find(([lim]) => p.frp < lim)[1];
  }
  const size = 3 + Math.min(7, Math.log2(1 + p.frp) * 0.9);
  return { color: cesColor(hex), size };
}

function renderLegend() {
  const rows = state.colorBy === 'age' ? AGE_COLORS : FRP_COLORS;
  const title = state.colorBy === 'age' ? 'Detection age' : 'Fire radiative power';
  const filtered = state.colorBy === 'age' ? rows.filter(([lim], i) => i === 0 || rows[i - 1][0] < state.range) : rows;
  $('#legend').innerHTML = `<div class="lg-title">${title}</div>` +
    filtered.map(([, c, l]) => `<div class="lg-row"><i style="background:${c}"></i>${l}</div>`).join('');
}

// ---------- Data ----------
async function fetchDay(source, date, force = false) {
  const key = `${source}|${date}`;
  const hit = dayCache.get(key);
  const isToday = date === utcDate(0);
  const fresh = hit && (!isToday || Date.now() - hit.fetchedAt < REFRESH_MS);
  if (hit && fresh && !force) return hit.points;

  const res = await fetch(`${API}?source=${source}&date=${date}`);
  let body;
  try { body = await res.json(); } catch { throw new Error(`Server returned HTTP ${res.status}`); }
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);

  const pts = body.rows.map((r) => {
    const d = body.dates[r[7]] || date;
    const hh = Math.floor(r[4] / 100); const mm = r[4] % 100;
    return {
      lat: r[0], lon: r[1], frp: r[2], conf: r[3], day: r[5], bt: r[6],
      t: Date.parse(`${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`),
      sat: body.sats[r[8]] || '', src: source,
    };
  });
  dayCache.set(key, { fetchedAt: Date.now(), points: pts });
  return pts;
}

async function loadData(force = false) {
  const nDays = Math.ceil(state.range / 24) + 1;
  const jobs = [];
  for (const s of state.sources) for (let i = 0; i < nDays; i++) jobs.push([s, utcDate(i)]);
  setBusy(true, `Loading ${jobs.length} day files…`);
  lastLoadError = null;
  let done = 0;
  const results = await Promise.all(jobs.map(([s, d]) =>
    fetchDay(s, d, force && d === utcDate(0))
      .catch((e) => { lastLoadError = e; return []; })
      .finally(() => { done++; $('#loaderText').textContent = `Loading detections… ${done}/${jobs.length}`; })));
  setBusy(false);
  if (lastLoadError && results.every((r) => !r.length)) toast(`Could not load data: ${lastLoadError.message}`, 10000);
  else if (lastLoadError) toast(`Some files failed: ${lastLoadError.message}`);
  draw();
}

function filtered() {
  const now = Date.now();
  const since = now - state.range * 36e5;
  const minFrp = FRP_STEPS[state.frpStep];
  const out = [];
  for (const s of state.sources) {
    for (const [k, v] of dayCache) {
      if (!k.startsWith(s + '|')) continue;
      for (const p of v.points) if (p.t >= since && p.conf >= state.minConf && p.frp >= minFrp) out.push(p);
    }
  }
  return out;
}

function draw() {
  const now = Date.now();
  visible = filtered();
  points.removeAll();
  for (let i = 0; i < visible.length; i++) {
    const p = visible[i];
    const st = pointStyle(p, now);
    points.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 50),
      color: st.color, pixelSize: st.size, outlineColor: OUTLINE, outlineWidth: 0.5,
      scaleByDistance: scaler, id: i,
    });
  }
  renderLegend();
  const latest = visible.reduce((m, p) => Math.max(m, p.t), 0);
  $('#status').textContent = `${visible.length.toLocaleString('en')} detections · last ${state.range === 168 ? '7 days' : state.range + ' h'}` +
    (latest ? ` · newest ${fmtAge(now - latest)}` : '');
  scene.requestRender();
  updateHotspots();
}

function setBusy(on, text) {
  $('#loader').hidden = !on;
  if (text) $('#loaderText').textContent = text;
  $('#btnRefresh').classList.toggle('spin', on);
}

// ---------- Hotspots (clusters) ----------
function clusters(regionKey) {
  const reg = REGIONS[regionKey];
  const cell = regionKey === 'world' ? 0.5 : 0.1;
  const map = new Map();
  for (const p of visible) {
    if (reg.bbox) { const [w, s, e, n] = reg.bbox; if (p.lon < w || p.lon > e || p.lat < s || p.lat > n) continue; }
    const k = `${Math.floor(p.lat / cell)}|${Math.floor(p.lon / cell)}`;
    let c = map.get(k);
    if (!c) map.set(k, (c = { n: 0, frp: 0, maxFrp: 0, lat: 0, lon: 0, last: 0, w: 0 }));
    const w = Math.max(p.frp, 0.5);
    c.n++; c.frp += p.frp; c.maxFrp = Math.max(c.maxFrp, p.frp); c.last = Math.max(c.last, p.t);
    c.lat += p.lat * w; c.lon += p.lon * w; c.w += w;
  }
  // merge neighbouring cells into fire complexes (simple union of adjacent cells)
  const keys = [...map.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { while (parent.get(k) !== k) k = parent.get(k); return k; };
  for (const k of keys) {
    const [a, b] = k.split('|').map(Number);
    for (const [da, db] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const nk = `${a + da}|${b + db}`;
      if (map.has(nk)) parent.set(find(nk), find(k));
    }
  }
  const groups = new Map();
  for (const k of keys) {
    const r = find(k); const c = map.get(k);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = { n: 0, frp: 0, maxFrp: 0, lat: 0, lon: 0, last: 0, w: 0 }));
    g.n += c.n; g.frp += c.frp; g.maxFrp = Math.max(g.maxFrp, c.maxFrp); g.last = Math.max(g.last, c.last);
    g.lat += c.lat; g.lon += c.lon; g.w += c.w;
  }
  let list = [...groups.values()].map((g) => ({ ...g, lat: g.lat / g.w, lon: g.lon / g.w }));
  if (reg.country && countries?.length) {
    list.forEach((g) => (g.country = countryAt(g.lat, g.lon)));
    list = list.filter((g) => g.country === reg.country);
  }
  return list.sort((a, b) => b.frp - a.frp);
}

let hotTimer;
function updateHotspots() {
  clearTimeout(hotTimer);
  hotTimer = setTimeout(async () => {
    await loadCountries();
    const list = clusters(state.region);
    const now = Date.now();
    const fresh = list.filter((g) => now - g.last < 6 * 36e5).length;
    const badge = $('#hotBadge');
    badge.hidden = !fresh; badge.textContent = fresh;
    $('#hotHint').textContent = list.length
      ? `${list.length} active area${list.length > 1 ? 's' : ''} in ${REGIONS[state.region].label}, ranked by total fire radiative power. ${fresh} with detections in the last 6 h.`
      : `No detections in ${REGIONS[state.region].label} with the current filters.`;
    const top = list.slice(0, 30);
    $('#hotList').innerHTML = top.map((g, i) => {
      const name = g.country || countryAt(g.lat, g.lon) || (countries?.length ? 'Offshore / border area' : 'Unknown country');
      const isNew = now - g.last < 6 * 36e5;
      return `<li data-i="${i}"><span class="rank">${i + 1}</span>
        <div><div class="main">${name}${isNew ? '<span class="new">NEW</span>' : ''}</div>
        <div class="sub">${fmtCoord(g.lat, g.lon)} · ${g.n} detection${g.n > 1 ? 's' : ''} · ${fmtAge(now - g.last)}</div></div>
        <span class="frp">${Math.round(g.frp).toLocaleString('en')}<br><span class="sub">MW</span></span></li>`;
    }).join('');
    $('#hotList').onclick = (ev) => {
      const li = ev.target.closest('li'); if (!li) return;
      const g = top[+li.dataset.i];
      closeSheet();
      flyTo(g.lat, g.lon, g.n > 40 ? 250000 : 120000);
    };
  }, 120);
}

// ---------- Interaction ----------
function flyTo(lat, lon, height = 150000) {
  viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(lon, lat, height), duration: 1.8 });
}

const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
handler.setInputAction((e) => {
  const picked = scene.pick(e.position);
  if (picked && picked.primitive instanceof Cesium.PointPrimitive && Number.isInteger(picked.id)) {
    showDetail(visible[picked.id]);
  } else if (!$('#sheet').hidden) {
    closeSheet();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

function showDetail(p) {
  const now = Date.now();
  $('#dTitle').textContent = `Detection · ${fmtAge(now - p.t)}`;
  const rows = [
    ['Time', `${fmtUtc(p.t)}<br><span class="hint">${fmtLocal(p.t)} local</span>`],
    ['Position', fmtCoord(p.lat, p.lon)],
    ['Country', countryAt(p.lat, p.lon) || '—'],
    ['FRP', `${p.frp.toLocaleString('en')} MW`],
    ['Confidence', CONF_LABEL[p.conf]],
    ['Brightness', `${p.bt} K`],
    ['Pass', p.day ? 'Day' : 'Night'],
    ['Sensor', `${SOURCES[p.src]}${p.sat ? ` (${p.sat})` : ''}`],
  ];
  $('#dList').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('#dFly').onclick = () => { closeSheet(); flyTo(p.lat, p.lon, 60000); };
  $('#dFirms').href = `https://firms.modaps.eosdis.nasa.gov/map/#d:24hrs;@${p.lon.toFixed(3)},${p.lat.toFixed(3)},11.0z`;
  openSheet('detail');
}

function openSheet(name) {
  const sheet = $('#sheet');
  sheet.querySelectorAll('[data-content]').forEach((el) => el.classList.toggle('show', el.dataset.content === name));
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  sheet.hidden = false; sheet.scrollTop = 0; sheet.dataset.open = name;
}
function closeSheet() {
  $('#sheet').hidden = true; delete $('#sheet').dataset.open;
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.remove('active'));
}
document.querySelectorAll('.dock-btn').forEach((b) => b.addEventListener('click', () => {
  if ($('#sheet').dataset.open === b.dataset.panel) closeSheet(); else openSheet(b.dataset.panel);
}));
$('#sheetClose').addEventListener('click', closeSheet);

function bindSeg(sel, key, onChange, parse = Number) {
  const root = $(sel);
  const sync = () => root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', parse(b.dataset.v) === state[key]));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state[key] = parse(b.dataset.v); sync(); save(); onChange();
  });
  sync();
}
bindSeg('#rangeSeg', 'range', () => loadData());
bindSeg('#confSeg', 'minConf', draw);
bindSeg('#colorSeg', 'colorBy', draw, String);
bindSeg('#regionSeg', 'region', updateHotspots, String);

(function bindSources() {
  const root = $('#srcChips');
  const sync = () => root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', state.sources.includes(b.dataset.v)));
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = b.dataset.v;
    if (state.sources.includes(v)) { if (state.sources.length > 1) state.sources = state.sources.filter((s) => s !== v); }
    else state.sources = [...state.sources, v];
    sync(); save(); loadData();
  });
  sync();
})();

const frpInput = $('#frpMin');
frpInput.value = state.frpStep;
const frpLabel = () => ($('#frpVal').textContent = FRP_STEPS[state.frpStep] ? `${FRP_STEPS[state.frpStep]} MW` : 'any');
frpLabel();
frpInput.addEventListener('input', () => { state.frpStep = +frpInput.value; frpLabel(); });
frpInput.addEventListener('change', () => { save(); draw(); });

(function bindLayers() {
  const sel = $('#baseSelect');
  const opts = [['bluemarble', 'Blue Marble (cloud-free)']];
  for (let i = 0; i < 8; i++) {
    const d = utcDate(i);
    opts.push([`tc:${d}`, `True color · ${d}${i === 0 ? ' (partial, today)' : i === 1 ? ' (yesterday)' : ''}`]);
  }
  if (!opts.some(([v]) => v === state.base)) state.base = 'bluemarble';
  sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  sel.value = state.base;
  sel.addEventListener('change', () => { state.base = sel.value; save(); applyBase(); });
  const nt = $('#nightToggle'); nt.checked = state.night;
  nt.addEventListener('change', () => { state.night = nt.checked; save(); applyNight(); });
  const bt = $('#bordersToggle'); bt.checked = state.borders;
  bt.addEventListener('change', () => { state.borders = bt.checked; save(); applyBorders(); });
})();

$('#btnRefresh').addEventListener('click', () => loadData(true));
$('#btnLocate').addEventListener('click', () => {
  if (!navigator.geolocation) return toast('Geolocation not available');
  navigator.geolocation.getCurrentPosition(
    (pos) => flyTo(pos.coords.latitude, pos.coords.longitude, 400000),
    () => toast('Location permission denied'),
    { enableHighAccuracy: false, timeout: 10000 });
});

// keep day/night terminator current and refresh data periodically
setInterval(() => { viewer.clock.currentTime = Cesium.JulianDate.now(); scene.requestRender(); }, 60000);
setInterval(() => { if (document.visibilityState === 'visible') loadData(); }, REFRESH_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const today = dayCache.get(`${state.sources[0]}|${utcDate(0)}`);
  if (!today || Date.now() - today.fetchedAt > REFRESH_MS) loadData();
});

// ---------- Start ----------
viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(12.5, 41.0, 9.0e6) });
applyNight();
applyBorders();
loadData();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
