import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID } from "node:crypto";
import router from "./import-runs.ts";
import {
  appFor,
  closeAllServers,
  listen,
} from "../test-helpers/route-harness.ts";

let url: string;
const id = randomUUID();
before(async () => {
  url = await listen(
    appFor(
      {
        userId: randomUUID(),
        firmId: randomUUID(),
        role: "firm_staff",
        clientPartyId: null,
        buyerPartyId: null,
        capabilities: [],
      },
      router,
    ),
  );
});
after(closeAllServers);

test("run endpoints require current read/write capabilities and disable caching", async () => {
  const manifest = {
    id,
    clientPartyId: randomUUID(),
    totalRows: 1,
    chunkSize: 1,
    chunkHashes: ["a".repeat(64)],
  };
  const requests = [
    { path: "/invoice-import-runs", method: "POST", body: manifest },
    { path: `/invoice-import-runs/${id}`, method: "GET" },
    {
      path: `/invoice-import-runs/${id}/chunks/0`,
      method: "POST",
      body: { rows: [{ rowNumber: 1 }] },
    },
    { path: `/invoice-import-runs/${id}/finalize`, method: "POST", body: {} },
  ];
  for (const request of requests) {
    const response = await fetch(`${url}${request.path}`, {
      method: request.method,
      headers: { "content-type": "application/json" },
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
    assert.equal(response.status, 403);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("chunk requests reject a client-selected key that differs from the run checkpoint key", async () => {
  const response = await fetch(`${url}/invoice-import-runs/${id}/chunks/0`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Idempotency-Key": "new-retry-key",
    },
    body: JSON.stringify({ rows: [{ rowNumber: 1 }] }),
  });
  assert.equal(response.status, 400);
  assert.match(await response.text(), /must equal runId:chunkIndex/);
});
