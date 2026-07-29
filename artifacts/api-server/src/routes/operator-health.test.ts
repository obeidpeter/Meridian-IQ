import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import operatorRouter from "./operator.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { appendAudit } from "../modules/audit/audit.ts";
import {
  RAIL_CIRCUIT_OPEN_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
} from "../modules/desk/health-watch.ts";
import { appFor, listen, closeAllServers } from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { crossTenantPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// GET /operator/health-alerts and GET /operator/rail-config. Pinned:
//  - health-alerts reads the watches' durable alerts back off the audit
//    ledger: only the closed action set, newest (highest seq) first, `detail`
//    passing the alert's `after` evidence through, capped at 50;
//  - rail-config reports PRESENCE BOOLEANS for the env-lit rails and never
//    echoes a value (the endpoint must not be a secrets oracle);
//  - both sit behind operator.queue.read (firm_admin is 403).

const SALT = makeRunSalt();

const operator: Principal = crossTenantPrincipal("operator");
const firmAdmin: Principal = firmPrincipal(randomUUID());

const railEntityId = `test_rail_${SALT}:2026-07-20T06:00:00.000Z`;
const deliveryId = randomUUID();
const webhookId = randomUUID();
const firmId = randomUUID();

interface AlertItem {
  seq: number;
  action: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  detail?: Record<string, unknown> | null;
}

before(async () => {
  // Durable alerts exactly as the health watch appends them (audit_events has
  // no RLS — appendAudit works on the raw pool).
  await appendAudit({
    actorId: "health-watch",
    actorRole: "system",
    action: RAIL_CIRCUIT_OPEN_ACTION,
    entityType: "rail",
    entityId: railEntityId,
    after: { rail: `test_rail_${SALT}`, failureCount: 3, reason: "test" },
  });
  await appendAudit({
    actorId: "health-watch",
    actorRole: "system",
    firmId,
    action: WEBHOOK_DELIVERY_DEAD_ACTION,
    entityType: "webhook_delivery",
    entityId: deliveryId,
    after: { webhookId, reason: "test" },
  });
  // An out-of-catalogue action must never surface as a health alert.
  await appendAudit({
    actorId: "health-watch",
    actorRole: "system",
    action: `test.not_health.${SALT}`,
    entityType: "rail",
    entityId: `noise-${SALT}`,
    after: { noise: true },
  });
});

after(async () => {
  await closeAllServers();
});

test("GET /operator/health-alerts serves the watches' durable alerts, newest first, actions filtered", async () => {
  const base = await listen(appFor(operator, operatorRouter));
  const res = await fetch(`${base}/operator/health-alerts`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as AlertItem[];
  assert.ok(Array.isArray(body));
  assert.ok(body.length <= 50);

  const rail = body.find((a) => a.entityId === railEntityId);
  assert.ok(rail, "the rail alert surfaces");
  assert.equal(rail.action, RAIL_CIRCUIT_OPEN_ACTION);
  assert.equal(rail.entityType, "rail");
  assert.ok(!Number.isNaN(Date.parse(rail.createdAt)), "createdAt serialized for the wire");
  assert.deepEqual(rail.detail, {
    rail: `test_rail_${SALT}`,
    failureCount: 3,
    reason: "test",
  });

  const webhook = body.find((a) => a.entityId === deliveryId);
  assert.ok(webhook, "the webhook alert surfaces");
  assert.deepEqual(webhook.detail, { webhookId, reason: "test" });

  // Newest first by ledger seq, and the webhook alert was appended after the
  // rail one.
  for (let i = 1; i < body.length; i++) {
    assert.ok(body[i - 1].seq > body[i].seq);
  }
  assert.ok(webhook.seq > rail.seq);

  assert.ok(
    body.every((a) => a.entityId !== `noise-${SALT}`),
    "out-of-catalogue actions stay out",
  );
});

test("GET /operator/rail-config reports presence booleans and never echoes a value", async () => {
  const secret = `super-secret-${SALT}`;
  const saved: Record<string, string | undefined> = {
    INBOUND_EMAIL_TOKEN: process.env.INBOUND_EMAIL_TOKEN,
    METRICS_TOKEN: process.env.METRICS_TOKEN,
    TOTP_REQUIRED_ROLES: process.env.TOTP_REQUIRED_ROLES,
  };
  process.env.INBOUND_EMAIL_TOKEN = secret;
  process.env.TOTP_REQUIRED_ROLES = "operator";
  delete process.env.METRICS_TOKEN;
  try {
    const base = await listen(appFor(operator, operatorRouter));
    const res = await fetch(`${base}/operator/rail-config`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(secret), "a configured value NEVER appears in the body");
    const body = JSON.parse(text) as {
      key: string;
      label: string;
      configured: boolean;
      note: string;
    }[];
    assert.deepEqual(
      body.map((e) => e.key),
      [
        "inbound_email",
        "inbound_whatsapp",
        "messaging_relay",
        "payment_provider",
        "payment_webhook",
        "metrics_token",
        "sweep_token",
        "totp_required_roles",
      ],
    );
    const byKey = new Map(body.map((e) => [e.key, e]));
    assert.equal(byKey.get("inbound_email")?.configured, true);
    assert.equal(byKey.get("totp_required_roles")?.configured, true);
    assert.equal(byKey.get("metrics_token")?.configured, false);
    assert.ok(body.every((e) => e.label.length > 0 && e.note.length > 0));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("both endpoints require operator.queue.read (firm_admin is 403)", async () => {
  const base = await listen(appFor(firmAdmin, operatorRouter));
  assert.equal((await fetch(`${base}/operator/health-alerts`)).status, 403);
  assert.equal((await fetch(`${base}/operator/rail-config`)).status, 403);
});
