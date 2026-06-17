// Service Worker for Familieplanlegger
// Denne filen MÅ ligge i roten av repoet (ikke i undermappe)
// slik at scope dekker hele /Familieplanlegger/-stien

/**
 * firebase-messaging-sw.js
 * Må ligge i PUBLIC-mappen (roten av nettstedet ditt).
 * F.eks.: annette-678.github.io/Sykluslogg/firebase-messaging-sw.js
 *
 * Denne filen mottar push-varsler selv når appen er lukket.
 */

// ─── BYTT UT med dine egne Firebase-verdier ───────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAKZ3N_RhjX2-bP9KQNKvBpNbJMMqZEu3w",
  authDomain:        "familieplanlegger-a978d.firebaseapp.com",
  projectId:         "familieplanlegger-a978d",
  storageBucket:     "familieplanlegger-a978d.firebasestorage.app",
  messagingSenderId: "107531873859",
  appId:             "1:107531873859:web:b8b8645b40840c33abeef6",
};
// ─────────────────────────────────────────────────────────────────────────────

importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Håndter varsler i bakgrunnen (appen lukket / i bakgrunn)
messaging.onBackgroundMessage(payload => {
  const { title, body } = payload.notification;
  self.registration.showNotification(title, {
    body,
    icon:  "/icon-192.png",
    badge: "/badge-72.png",
    tag:   payload.data?.tag || "familiekalender",
    data:  { url: "/" },
  });
});

// Klikk på varselet åpner appen
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow("/");
    })
  );
});
