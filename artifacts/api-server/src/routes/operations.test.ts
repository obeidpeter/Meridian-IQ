import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import express from "express";
import operationsRouter from "./operations.ts";
import {
  appFor,
  closeAllServers,
  listen,
} from "../test-helpers/route-harness.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { executeHttpOperation } from "../modules/operations/http.ts";

const principal: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  firmId: "22222222-2222-4222-8222-222222222222",
  clientPartyId: null,
  buyerPartyId: null,
  role: "firm_staff",
  capabilities: [],
};
let url: string;
before(async () => {
  url = await listen(appFor(principal, operationsRouter));
});
after(closeAllServers);

test("recovery routes require invoice.read and send no-store on denied requests", async () => {
  for (const path of [
    "/operations",
    "/operations/lookup?command=invoice.create&idempotencyKey=known",
    "/operations/11111111-1111-4111-8111-111111111111",
  ]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 403);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("recovery queries reject unbounded reads and user-supplied ownership filters", async () => {
  for (const path of [
    "/operations?limit=0",
    "/operations?limit=101",
    "/operations?limit=1.5",
    "/operations?actorId=other",
    "/operations?firmId=other",
    "/operations/lookup?command=invoice.create",
    "/operations/lookup?command=arbitrary&idempotencyKey=x",
    "/operations/not-a-uuid",
  ]) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 400, path);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
});

test("HTTP command helper requires X-Idempotency-Key, not the legacy header", async () => {
  const router = express.Router();
  router.post("/command", (req, res) =>
    executeHttpOperation(req, res, {
      command: "invoice.create",
      clientPartyId: principal.firmId!,
      payload: {},
      execute: async () => {
        assert.fail("invalid request must not execute");
      },
    }),
  );
  const base = await listen(appFor(principal, router));
  for (const headers of [
    {},
    { "Idempotency-Key": "legacy" },
    { "X-Idempotency-Key": "one,two" },
  ]) {
    const response = await fetch(`${base}/command`, {
      method: "POST",
      headers,
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /X-Idempotency-Key must contain/);
  }
});
