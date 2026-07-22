// Service worker de Firebase Cloud Messaging — muestra las notificaciones push del chat en segundo plano.
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

const messaging = firebase.messaging();

// Mensaje SOLO-DATA (el backend no manda 'notification' para NO duplicar) → mostramos UNA notificación.
messaging.onBackgroundMessage((payload) => {
  const d = (payload && payload.data) || {};
  self.registration.showNotification(d.title || 'Legacy Chat', {
    body: d.body || '',
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: (d.url || '/warehouse.html'), channel: (d.channel || '') },
    tag: 'legacy-chat-' + (d.channel || 'x'),   // agrupa por canal (no apila 20)
  });
});

// Al tocar la notificación → abre/enfoca la app EN ESA conversación.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const channel = data.channel || '';
  const url = data.url || '/warehouse.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.indexOf('warehouse') >= 0) {
          w.focus();
          w.postMessage({ type: 'open-chat', channel: channel });   // app ya abierta → ábrele el chat
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);   // app cerrada → abre con ?chat=canal
    })
  );
});
