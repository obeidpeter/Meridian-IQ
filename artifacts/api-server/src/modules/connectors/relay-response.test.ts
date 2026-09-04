import { test } from "node:test";
import assert from "node:assert/strict";
import { readBoundedJsonObject } from "./relay-response.ts";

test("bounded relay parsing accepts a JSON object", async () => {
  const response = new Response(JSON.stringify({ ok: true, rows: [] }));
  assert.deepEqual(
    await readBoundedJsonObject(response, 1_024, "Test relay"),
    { ok: true, rows: [] },
  );
});

test("bounded relay parsing rejects declared and streamed oversize bodies", async () => {
  const declared = new Response("{}", {
    headers: { "content-length": "2048" },
  });
  await assert.rejects(
    readBoundedJsonObject(declared, 32, "Test relay"),
    /too large/,
  );

  const streamed = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(24));
        controller.enqueue(new Uint8Array(24));
        controller.close();
      },
    }),
  );
  await assert.rejects(
    readBoundedJsonObject(streamed, 32, "Test relay"),
    /too large/,
  );
});

test("bounded relay parsing rejects invalid JSON shapes", async () => {
  await assert.rejects(
    readBoundedJsonObject(new Response("not-json"), 100, "Test relay"),
    /invalid JSON/,
  );
  await assert.rejects(
    readBoundedJsonObject(new Response("[]"), 100, "Test relay"),
    /invalid response/,
  );
});
