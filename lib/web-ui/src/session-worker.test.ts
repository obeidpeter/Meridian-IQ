import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, test } from "vitest";

test("root cleanup worker removes legacy caches without evicting current SME or sibling caches", async () => {
  const caches = new Set([
    "meridianiq-v1",
    "meridianiq-v3",
    "meridianiq-sme-static-v4",
    "other-app",
  ]);
  const handlers = new Map<
    string,
    (event: { waitUntil: (promise: Promise<unknown>) => void }) => void
  >();
  let work: Promise<unknown> | undefined;
  vm.runInNewContext(
    readFileSync(
      new URL("../../../artifacts/landing/public/sw.js", import.meta.url),
      "utf8",
    ),
    {
      caches: {
        keys: async () => [...caches],
        delete: async (key: string) => caches.delete(key),
      },
      self: {
        addEventListener: (
          type: string,
          handler: typeof handlers extends Map<string, infer V> ? V : never,
        ) => handlers.set(type, handler),
        skipWaiting() {},
        clients: { claim: async () => {} },
      },
    },
  );
  handlers.get("activate")!({
    waitUntil: (promise) => {
      work = promise;
    },
  });
  await work;
  expect([...caches]).toEqual(["meridianiq-sme-static-v4", "other-app"]);
  expect(handlers.has("fetch")).toBe(false);
});
