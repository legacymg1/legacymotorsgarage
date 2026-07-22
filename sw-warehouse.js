// Service worker de Legacy Warehouse — solo controla la app del almacén.
// No toca finanzas/admin/index (su fetch los deja pasar normal).
const CACHE = 'legacy-wh-v2';
const SHELL = ['./warehouse.html','./manifest-warehouse.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.map(k => k !== CACHE ? caches.delete(k) : null)))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url; try { url = new URL(req.url); } catch (_) { return; }

  const isShell = url.origin === location.origin && (
    url.pathname.endsWith('/warehouse.html') ||
    url.pathname.endsWith('/manifest-warehouse.json') ||
    /icon-\d+\.png$|apple-touch-icon\.png$/.test(url.pathname)
  );
  const isCDN = url.origin === 'https://www.gstatic.com' || url.origin === 'https://cdn.jsdelivr.net';

  if (isShell) {
    // network-first + bypass del caché HTTP del navegador: SIEMPRE la versión más nueva con internet.
    e.respondWith(
      fetch(req, { cache: 'reload' }).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; })
        .catch(() => caches.match(req).then(m => m || caches.match('./warehouse.html')))
    );
  } else if (isCDN) {
    // cache-first para las librerías (firebase, qr) → carga rápida y offline del shell
    e.respondWith(
      caches.match(req).then(m => m || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return r; }))
    );
  }
  // cualquier otra cosa (finanzas, admin, firestore, etc.): el navegador la maneja normal
});
