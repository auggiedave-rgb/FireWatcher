// FireWatch – FIRMS proxy
// GET /api/fires?source=VIIRS_NOAA20_NRT&date=YYYY-MM-DD
// Fetches one UTC day of global active-fire detections from NASA FIRMS,
// converts the CSV into a compact JSON payload and lets Netlify's CDN cache it,
// so FIRMS is called at most once per (source, date) per cache period.

const SOURCES = new Set([
  'VIIRS_NOAA20_NRT',
  'VIIRS_NOAA21_NRT',
  'VIIRS_SNPP_NRT',
  'MODIS_NRT',
]);

const FIRMS = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

const noStore = { 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' };

function utcDay(offsetDays = 0) {
  return new Date(Date.now() - offsetDays * 864e5).toISOString().slice(0, 10);
}

function confCode(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'l' || v === 'low') return 0;
  if (v === 'n' || v === 'nominal') return 1;
  if (v === 'h' || v === 'high') return 2;
  const n = Number(v); // MODIS: 0-100
  if (Number.isFinite(n)) return n < 30 ? 0 : n < 80 ? 1 : 2;
  return 1;
}

const round = (x, d) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};

export function parseFirmsCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { dates: [], sats: [], rows: [] };
  const head = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const ix = (name) => head.indexOf(name);
  const iLat = ix('latitude');
  const iLon = ix('longitude');
  if (iLat < 0 || iLon < 0) throw new Error(lines[0].slice(0, 200));
  const iFrp = ix('frp');
  const iConf = ix('confidence');
  const iDate = ix('acq_date');
  const iTime = ix('acq_time');
  const iDn = ix('daynight');
  const iBt = ix('bright_ti4') >= 0 ? ix('bright_ti4') : ix('brightness');
  const iSat = ix('satellite');

  const dates = [];
  const sats = [];
  const idxOf = (arr, v) => {
    let i = arr.indexOf(v);
    if (i < 0) { arr.push(v); i = arr.length - 1; }
    return i;
  };

  const rows = [];
  for (let k = 1; k < lines.length; k++) {
    const c = lines[k].split(',');
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    rows.push([
      round(lat, 4),
      round(lon, 4),
      iFrp >= 0 ? round(Number(c[iFrp]) || 0, 1) : 0,
      iConf >= 0 ? confCode(c[iConf]) : 1,
      iTime >= 0 ? Number(c[iTime]) || 0 : 0, // HHMM UTC
      iDn >= 0 ? (String(c[iDn]).trim().toUpperCase() === 'N' ? 0 : 1) : 1,
      iBt >= 0 ? round(Number(c[iBt]) || 0, 1) : 0,
      idxOf(dates, iDate >= 0 ? c[iDate].trim() : ''),
      idxOf(sats, iSat >= 0 ? c[iSat].trim() : ''),
    ]);
  }
  return { dates, sats, rows };
}

export default async (req) => {
  const url = new URL(req.url);
  const source = url.searchParams.get('source') || 'VIIRS_NOAA20_NRT';
  const date = url.searchParams.get('date') || utcDay(0);

  if (!SOURCES.has(source)) return json({ error: `Unknown source ${source}` }, 400, noStore);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: 'Bad date' }, 400, noStore);
  const ageDays = Math.round((Date.parse(utcDay(0)) - Date.parse(date)) / 864e5);
  if (ageDays < 0 || ageDays > 9) return json({ error: 'Date must be within the last 10 days (UTC)' }, 400, noStore);

  const key = (globalThis.Netlify?.env?.get('FIRMS_MAP_KEY')) || process.env.FIRMS_MAP_KEY;
  if (!key) return json({ error: 'FIRMS_MAP_KEY is not configured on the server' }, 500, noStore);

  let text;
  try {
    const r = await fetch(`${FIRMS}/${key}/${source}/-180,-90,180,90/1/${date}`, {
      signal: AbortSignal.timeout(20000),
    });
    text = await r.text();
    if (!r.ok) throw new Error(`FIRMS HTTP ${r.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    return json({ error: `FIRMS request failed: ${e.message}` }, 502, noStore);
  }

  let parsed;
  try {
    parsed = parseFirmsCsv(text);
  } catch (e) {
    // FIRMS answers errors (bad key, quota) as plain text with HTTP 200
    return json({ error: `FIRMS error: ${e.message}` }, 502, noStore);
  }

  // Today's file keeps growing; yesterday still receives late NRT granules.
  const sMaxAge = ageDays === 0 ? 900 : ageDays === 1 ? 3600 : 43200;

  return json(
    {
      source,
      date,
      generated: new Date().toISOString(),
      fields: ['lat', 'lon', 'frp', 'conf', 'hhmm', 'day', 'bt', 'dateIdx', 'satIdx'],
      ...parsed,
    },
    200,
    {
      'Cache-Control': `public, max-age=${Math.min(sMaxAge, 600)}`,
      'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge}`,
      'Netlify-Vary': 'query=source|date',
    }
  );
};

export const config = { path: '/api/fires' };
