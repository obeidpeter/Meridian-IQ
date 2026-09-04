import test from "node:test";
import assert from "node:assert/strict";
import { metroResponseError } from "../../../artifacts/mobile/scripts/metro-response.cjs";

test("Metro bundle failures report actionable JSON messages and status", async () => {
  const error = await metroResponseError(
    Response.json(
      { message: "Unable to resolve module ./missing from Invoice.tsx" },
      { status: 500 },
    ),
  );
  assert.match(error.message, /Metro HTTP 500: Unable to resolve module/);
});

test("Metro diagnostics bound response bytes and cancel unending streams", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const error = await metroResponseError(new Response(body, { status: 500 }), {
    limit: 1024,
  });
  assert.ok(error.message.length < 1100);
  assert.match(error.message, /diagnostic truncated/);
  assert.equal(cancelled, true);
});

test("Metro diagnostic timeout cancels a stalled body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const error = await metroResponseError(new Response(body, { status: 500 }), {
    timeoutMs: 20,
  });
  assert.match(error.message, /no diagnostic body.*truncated/);
  assert.equal(cancelled, true);
});
