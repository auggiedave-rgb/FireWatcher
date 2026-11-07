// FireWatch service worker: minimal on purpose.
// It keeps the app installable but stores nothing: every request goes straight to the network.
// On activation it also deletes any cache created by earlier versions.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// No respondWith(): the browser handles the request normally (network, standard HTTP cache rules).
self.addEventListener('fetch', () => {});
