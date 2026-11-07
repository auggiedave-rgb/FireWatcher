// FireWatch service worker: app shell cache + last fire data available offline
const VERSION = 'fw-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Fire data: network first, fall back to the last copy when offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // App shell: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
