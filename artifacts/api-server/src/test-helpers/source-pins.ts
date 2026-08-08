import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Shared plumbing for the source-pin posture tests (the readFileSync
// tripwires: auth-route-posture, clerk-route-posture,
// billing-payments-posture, collections-posture). Only the fs/string mechanics
// live here — every
// assertion that pins an invariant stays in the test that owns it, against
// the same literals as before.

// Read a source file by its src/-relative path (this helper lives in
// src/test-helpers/, so ".." lands on src/ — the same resolution the tests
// previously did from routes/ and middleware/).
export const src = (rel: string): string =>
  readFileSync(join(import.meta.dirname, "..", rel), "utf8");

// The slice of `source` from a route path's registration up to the next
// route registration (or EOF) — enough to hold the handler.
export function routeBlock(source: string, path: string): string {
  const start = source.indexOf(`"${path}"`);
  assert.ok(start >= 0, `route ${path} exists`);
  const next = source.indexOf("router.", source.indexOf("=>", start));
  return source.slice(start, next === -1 ? undefined : next);
}

// The slice of `source` from a Set/array marker (e.g. "NO_CONTEXT_ROUTES =
// new Set(") to the "])" that closes it.
export function setBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${marker} exists`);
  return source.slice(start, source.indexOf("])", start));
}
