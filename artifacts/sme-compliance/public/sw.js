const CACHE = "meridianiq-sme-static-v4";
const OWNED_PREFIX = "meridianiq-sme-static-";
const LEGACY_CACHE = /^meridianiq-v\d+$/;
const scope = new URL(self.registration.scope);

// Only public, fingerprinted build assets inside this app's scope.
// Navigations, APIs, downloads and sibling apps bypass this worker.
function isStatic(request) {
  const url = new URL(request.url);
  const assets = `${scope.pathname}assets/`;
  return (
    request.method === "GET" &&
    request.mode !== "navigate" &&
    !request.headers.has("authorization") &&
    url.origin === scope.origin &&
    !url.search &&
    url.pathname.startsWith(assets) &&
    /^[\w.-]+-[\w-]{8,}\.(?:js|css|woff2?|png|jpe?g|webp|avif|svg|ico)$/.test(
      url.pathname.slice(assets.length),
    )
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
        Promise.all(
          keys
            .filter(
              (key) =>
                LEGACY_CACHE.test(key) ||
                (key.startsWith(OWNED_PREFIX) && key !== CACHE),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Network-first, static-only. CacheStorage does not enforce HTTP no-store.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (!isStatic(req)) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const control = res.headers.get("cache-control") ?? "";
        const type = res.headers.get("content-type") ?? "";
        if (
          res.ok &&
          !res.redirected &&
          res.type !== "opaque" &&
          !/no-store|private/i.test(control) &&
          /^(?:text\/(?:javascript|css)|application\/(?:javascript|x-javascript|font-woff)|font\/(?:woff2?|ttf|otf)|image\/(?:png|jpeg|webp|avif|svg\+xml|x-icon|vnd.microsoft.icon))(?:;|$)/i.test(
            type,
          ) &&
          !res.headers.has("content-disposition")
        ) {
          const copy = res.clone();
          event.waitUntil(
            caches
              .open(CACHE)
              .then((c) => c.put(req, copy))
              .catch(() => {}),
          );
        }
        return res;
      })
      .catch(async () => {
        try {
          const cache = await caches.open(CACHE);
          return (await cache.match(req)) ?? Response.error();
        } catch {
          return Response.error();
        }
      }),
  );
});
