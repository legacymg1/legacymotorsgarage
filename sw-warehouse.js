// Service worker de Legacy Warehouse — controla la app del almacén: caché OFFLINE + NOTIFICACIONES (FCM).
// Un SOLO service worker (antes había dos y chocaban → sacaba la sesión y no limpiaba notificaciones).
const CACHE = 'legacy-wh-v5';
const SHELL = ['./warehouse.html','./manifest-warehouse.json','./icon-192.png','./icon-512.png','./apple-touch-icon.png'];

// ---- 🔔 FCM (notificaciones) dentro de este mismo SW ----
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');
firebase.initializeApp({
  apiKey: "AIzaSyDrCMJQclGosVp3EV49vmwKDnji-Oti5j0",
  authDomain: "legacy-motors-garage.firebaseapp.com",
  projectId: "legacy-motors-garage",
  storageBucket: "legacy-motors-garage.firebasestorage.app",
  messagingSenderId: "783567672493",
  appId: "1:783567672493:web:3a825f2f59ec1c25e9a224"
});
const _msg = firebase.messaging();
_msg.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  self.registration.showNotification(d.title || 'Legacy Chat', {
    body: d.body || '', icon: './icon-192.png', badge: './icon-192.png',
    data: { url: (d.url || '/warehouse.html'), channel: (d.channel || '') },
    tag: 'legacy-chat-' + (d.channel || 'x'),
  });
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || '/warehouse.html';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    for (const w of wins) { if (w.url.indexOf('warehouse') >= 0) { w.focus(); w.postMessage({ type: 'open-chat', channel: data.channel || '' }); return; } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  }));
});
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'lmg-clear-notifs') {
    event.waitUntil(self.registration.getNotifications().then((ns) => ns.forEach((n) => n.close())).catch(() => {}));
  }
});

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
