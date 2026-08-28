import { after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import publicRouter from "./public.ts";
import {
  appFor,
  closeAllServers,
  JSON_HEADERS,
  listen,
} from "../test-helpers/route-harness.ts";
import { crossTenantPrincipal } from "../test-helpers/principals.ts";

const originalRelayUrl = process.env.MESSAGING_WEBHOOK_URL;
const originalRelayToken = process.env.MESSAGING_WEBHOOK_TOKEN;
const principal = crossTenantPrincipal("operator");

after(async () => {
  if (originalRelayUrl === undefined) delete process.env.MESSAGING_WEBHOOK_URL;
  else process.env.MESSAGING_WEBHOOK_URL = originalRelayUrl;
  if (originalRelayToken === undefined)
    delete process.env.MESSAGING_WEBHOOK_TOKEN;
  else process.env.MESSAGING_WEBHOOK_TOKEN = originalRelayToken;
  await closeAllServers();
});

test("advisory requests require consent and report a dark relay", async () => {
  delete process.env.MESSAGING_WEBHOOK_URL;
  const base = await listen(appFor(principal, publicRouter));
  const request = (consent: boolean) =>
    fetch(`${base}/public/advisory-requests`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        email: "owner@example.test",
        businessName: "Example Ltd",
        estimateSummary: "Estimated exposure: NGN 0",
        consent,
      }),
    });

  assert.equal((await request(false)).status, 400);
  assert.equal((await request(true)).status, 503);
});

test("a consented advisory request reaches only the configured relay", async () => {
  const seen: Array<{ body: unknown; token?: string }> = [];
  const relay = express();
  relay.use(express.json());
  relay.post("/hook", (req, res) => {
    seen.push({ body: req.body, token: req.get("x-op-token") });
    res.sendStatus(204);
  });
  const relayBase = await listen(relay);
  process.env.MESSAGING_WEBHOOK_URL = `${relayBase}/hook`;
  process.env.MESSAGING_WEBHOOK_TOKEN = "public-route-test";

  const base = await listen(appFor(principal, publicRouter));
  const response = await fetch(`${base}/public/advisory-requests`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: "owner@example.test",
      businessName: " Example Ltd ",
      estimateSummary: "Estimated exposure: NGN 0",
      consent: true,
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(seen, [
    {
      token: "public-route-test",
      body: {
        kind: "advisory_request",
        email: "owner@example.test",
        businessName: "Example Ltd",
        estimateSummary: "Estimated exposure: NGN 0",
      },
    },
  ]);
});

test("usability telemetry accepts only the closed aggregate schema", async () => {
  const base = await listen(appFor(principal, publicRouter));
  const valid = await fetch(`${base}/public/usability-events`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      event: "workflow_started",
      surface: "client_import",
    }),
  });
  assert.equal(valid.status, 204);

  const withFreeText = await fetch(`${base}/public/usability-events`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      event: "workflow_started",
      surface: "client_import",
      query: "customer name",
    }),
  });
  assert.equal(withFreeText.status, 400);
});
