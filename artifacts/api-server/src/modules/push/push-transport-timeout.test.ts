import { test } from "node:test";
import assert from "node:assert/strict";
import { src } from "../../test-helpers/source-pins.ts";
import { EXPO_TIMEOUT_MS } from "./push.ts";

// R105: every sweep that fans out a push bottoms out in the two Expo fetches
// below. An unbounded fetch there was an unbounded sweep pass (the audit found
// eleven sweeps exposed), so both calls must carry a timeout signal.
test("both Expo transports carry a bounded abort signal", () => {
  const source = src("modules/push/push.ts");
  for (const url of ["EXPO_PUSH_URL", "EXPO_RECEIPTS_URL"]) {
    const at = source.indexOf(`fetch(${url}, {`);
    assert.ok(at >= 0, `${url} fetch is present`);
    const call = source.slice(at, at + 200);
    assert.ok(
      call.includes("signal: AbortSignal.timeout(EXPO_TIMEOUT_MS)"),
      `${url} fetch is bounded by EXPO_TIMEOUT_MS`,
    );
  }
  assert.ok(EXPO_TIMEOUT_MS >= 1_000 && EXPO_TIMEOUT_MS <= 30_000);
});
