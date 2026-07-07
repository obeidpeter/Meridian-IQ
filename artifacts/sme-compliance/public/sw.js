const CACHE = "meridianiq-v2";

// This app is served at the origin root ("/"), so its service worker scope
// covers the ENTIRE origin — including sibling artifacts served under their own
// path prefixes. Those apps must never be intercepted or cached by this SW, or
// they get served this app's cached shell instead of their own. Bypass them.
const FOREIGN_PREFIXES = ["/console/", "/penalty-calculator/", "/__mockup"];

function isForeign(pathname) {
  return FOREIGN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch requests that belong to a sibling artifact — let them go
  // straight to the network so each app serves its own content.
  if (url.origin === self.location.origin && isForeign(url.pathname)) return;

  // API: network-first so data is fresh online, cached copy served offline.
  if (url.pathname.includes("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // App shell / assets: cache-first, fall back to network, then the shell.
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => caches.match(self.registration.scope)),
    ),
  );
});
