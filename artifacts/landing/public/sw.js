// Self-healing root service worker.
//
// The SME Compliance app used to be served at "/", so returning browsers may
// still hold its root-scoped service worker (scope "/"), which would hijack
// this portal and every sibling app on the origin (see the known-issue note in
// .agents/memory/service-worker-scope.md). This SW exists to REPLACE that stale
// worker: same URL ("/sw.js"), same scope ("/"), but it caches nothing and
// intercepts nothing — it simply takes over, purges old caches, and lets every
// request go straight to the network so each app serves its own content.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// No fetch handler that calls respondWith → the browser handles every request
// normally. The portal and all sibling apps load fresh from the network.
