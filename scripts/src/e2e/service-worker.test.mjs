import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Execute the production worker, not a reimplementation of its URL predicate.
function worker() {
  const handlers = new Map();
  const stores = new Map();
  let network = async () =>
    new Response("account A", { headers: { "cache-control": "no-store" } });
  const key = (request) =>
    typeof request === "string" ? request : request.url;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    open: async (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        put: async (request, response) =>
          store.set(key(request), response.clone()),
        match: async (request) => store.get(key(request))?.clone(),
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        delete: async (request) => store.delete(key(request)),
      };
    },
    match: async (request) => {
      for (const store of stores.values())
        if (store.has(key(request))) return store.get(key(request)).clone();
    },
  };
  vm.runInNewContext(
    readFileSync(
      new URL(
        "../../../artifacts/sme-compliance/public/sw.js",
        import.meta.url,
      ),
      "utf8",
    ),
    {
      URL,
      Request,
      Response,
      caches,
      fetch: (request) => network(request),
      self: {
        registration: { scope: "https://fixture.invalid/app/" },
        location: { origin: "https://fixture.invalid" },
        skipWaiting() {},
        clients: { claim: async () => {} },
        addEventListener: (name, callback) => handlers.set(name, callback),
      },
    },
  );
  return {
    caches,
    stores,
    setNetwork: (fn) => {
      network = fn;
    },
    async dispatch(type, request) {
      const pending = [];
      let response;
      handlers.get(type)?.({
        request,
        waitUntil: (promise) => pending.push(promise),
        respondWith: (promise) => {
          response = promise;
        },
      });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
  };
}

test("worker upgrade removes legacy account responses without deleting sibling caches", async () => {
  const sw = worker();
  await (
    await sw.caches.open("meridianiq-v3")
  ).put("https://fixture.invalid/api/me", new Response("account A"));
  await (
    await sw.caches.open("sibling-static-v1")
  ).put("https://fixture.invalid/console/a.js", new Response("sibling"));
  await sw.dispatch("activate");
  assert.equal(
    await sw.caches.match("https://fixture.invalid/api/me"),
    undefined,
  );
  assert.equal(
    await (
      await sw.caches.match("https://fixture.invalid/console/a.js")
    ).text(),
    "sibling",
  );
});

test("account switch, revoked session and offline API requests never enter worker CacheStorage", async () => {
  const sw = worker();
  for (const state of ["A", "B", "revoked", "offline"]) {
    sw.setNetwork(async () => {
      if (state === "offline") throw new Error("offline");
      return new Response(state, { status: state === "revoked" ? 401 : 200 });
    });
    for (const route of [
      "/api/me",
      "/api/invoices",
      "/api/invoices/export",
      "/app/",
      "/console/assets/app-12345678.js",
    ]) {
      assert.equal(
        await sw.dispatch(
          "fetch",
          new Request(`https://fixture.invalid${route}`),
        ),
        undefined,
        `${state}: ${route} bypasses worker`,
      );
    }
  }
  assert.equal(sw.stores.size, 0);
});

test("Valo upgrade removes previous-brand static caches but retains current and unrelated caches", async () => {
  const sw = worker();
  for (const name of [
    "meridianiq-sme-static-v4",
    "valo-sme-static-v4",
    "valo-sme-static-v5",
    "sibling-static-v1",
  ])
    await sw.caches.open(name);
  await sw.dispatch("activate");
  assert.deepEqual(await sw.caches.keys(), [
    "valo-sme-static-v5",
    "sibling-static-v1",
  ]);
});

test("public fingerprinted assets work offline; private, no-store, HTML and bearer responses do not persist", async () => {
  const sw = worker();
  const asset = new Request(
    "https://fixture.invalid/app/assets/index-12345678.js",
  );
  sw.setNetwork(
    async () =>
      new Response("public bytes", {
        headers: { "content-type": "text/javascript" },
      }),
  );
  assert.equal(
    await (await sw.dispatch("fetch", asset)).text(),
    "public bytes",
  );
  sw.setNetwork(async () => {
    throw new Error("offline");
  });
  assert.equal(
    await (await sw.dispatch("fetch", asset)).text(),
    "public bytes",
  );
  for (const headers of [
    { "cache-control": "no-store" },
    { "cache-control": "private" },
    { "content-type": "text/html" },
  ]) {
    const fresh = worker();
    fresh.setNetwork(async () => new Response("sensitive", { headers }));
    await fresh.dispatch("fetch", asset);
    assert.equal(await fresh.caches.match(asset), undefined);
  }
  assert.equal(
    await sw.dispatch(
      "fetch",
      new Request(asset, { headers: { authorization: "Bearer test" } }),
    ),
    undefined,
  );
});
