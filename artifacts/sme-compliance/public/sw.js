const CACHE = "meridianiq-v3";

// This app is served at the origin root ("/"), so its service worker scope
// covers the ENTIRE origin — including sibling artifacts served under their own
// path prefixes. Those apps must never be intercepted or cached by this SW, or
// they get served this app's cached shell instead of their own. Bypass them.
const FOREIGN_PREFIXES = [
  "/console/",
  "/penalty-calculator/",
  "/buyer/",
  "/__mockup",
];

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

// Network-first for EVERYTHING (shell, assets and API): fresh content is
// always served when online, and the cache is only a fallback for offline
// use. Cache-first shell serving previously hid newly deployed features
// (e.g. the Clerk nav) until users hard-refreshed — never reintroduce it.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never touch requests that belong to a sibling artifact — let them go
  // straight to the network so each app serves its own content.
  if (url.origin === self.location.origin && isForeign(url.pathname)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        // Only keep responses worth serving offline; never cache error pages.
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(req, copy)));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          // Fall back to the cached shell only for page navigations, so a
          // failed asset/API fetch offline doesn't get HTML instead.
          if (req.mode === "navigate") {
            return caches.match(self.registration.scope);
          }
          return Response.error();
        }),
      ),
  );
});
