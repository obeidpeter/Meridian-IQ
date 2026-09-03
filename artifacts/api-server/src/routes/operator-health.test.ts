import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb, railStatesTable } from "@workspace/db";
import operatorRouter from "./operator.ts";
import { setRailTransport } from "../modules/rails/adapter.ts";
import { scriptedRail } from "../modules/rails/transports/scripted.ts";
import type { Principal } from "../modules/auth/rbac.ts";
import { appendAudit } from "../modules/audit/audit.ts";
import {
  RAIL_CIRCUIT_OPEN_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
} from "../modules/desk/health-watch.ts";
import { appFor, listen, closeAllServers } from "../test-helpers/route-harness.ts";
import { makeRunSalt } from "../test-helpers/fixtures.ts";
import { crossTenantPrincipal, firmPrincipal } from "../test-helpers/principals.ts";

// GET /operator/health-alerts, GET /operator/rail-config and GET
// /operator/rails. Pinned:
//  - health-alerts reads the watches' durable alerts back off the audit
//    ledger: only the closed action set, newest (highest seq) first, `detail`
//    passing the alert's `after` evidence through, capped at 50;
//  - rail-config reports PRESENCE BOOLEANS for the env-lit rails and never
//    echoes a value (the endpoint must not be a secrets oracle); a
//    whitespace-only value is not configured;
//  - rails always lists BOTH rails in order, naming the live transport and
//    its environment, synthesising a closed breaker for a rail that has no
//    rail_states row yet, and marking a rail the transport does not serve
//    `configured: false` — again without a URL or secret in the body;
//  - all sit behind operator.queue.read (firm_admin is 403).

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
    RAIL_PRIMARY_URL: process.env.RAIL_PRIMARY_URL,
    RAIL_SECONDARY_URL: process.env.RAIL_SECONDARY_URL,
  };
  process.env.INBOUND_EMAIL_TOKEN = secret;
  process.env.TOTP_REQUIRED_ROLES = "operator";
  delete process.env.METRICS_TOKEN;
  // One access-point rail lit (R95): presence only, never the URL itself.
  process.env.RAIL_PRIMARY_URL = `https://rail.example/${secret}`;
  delete process.env.RAIL_SECONDARY_URL;
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
        "rail_primary",
        "rail_secondary",
        "payment_webhook",
        "collection_webhook",
        "metrics_token",
        "sweep_token",
        "totp_required_roles",
      ],
    );
    const byKey = new Map(body.map((e) => [e.key, e]));
    assert.equal(byKey.get("inbound_email")?.configured, true);
    assert.equal(byKey.get("rail_primary")?.configured, true);
    assert.equal(byKey.get("rail_secondary")?.configured, false);
    // Key IDS only (R100): the single legacy token reads as the `legacy` id;
    // a ring lists its ids; a URL-style entry has none.
    assert.deepEqual(
      (byKey.get("inbound_email") as { keyIds?: string[] })?.keyIds,
      ["legacy"],
    );
    assert.deepEqual(
      (byKey.get("totp_required_roles") as { keyIds?: string[] })?.keyIds,
      [],
    );
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

test("GET /operator/rail-config: a whitespace-only RAIL_PRIMARY_URL is not configured", async () => {
  const saved = process.env.RAIL_PRIMARY_URL;
  process.env.RAIL_PRIMARY_URL = "   ";
  try {
    const base = await listen(appFor(operator, operatorRouter));
    const res = await fetch(`${base}/operator/rail-config`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { key: string; configured: boolean }[];
    assert.equal(body.find((e) => e.key === "rail_primary")?.configured, false);
  } finally {
    if (saved === undefined) delete process.env.RAIL_PRIMARY_URL;
    else process.env.RAIL_PRIMARY_URL = saved;
  }
});

interface RailStateItem {
  rail: string;
  state: string;
  failureCount: number;
  openedAt: string | null;
  retryAt: string | null;
  transport: string;
  environment: string;
  configured: boolean;
}

test("GET /operator/rails lists both rails in order with the transport, synthesising a closed row for a rail without one, and never a URL or secret", async () => {
  const secret = `rail-secret-${SALT}`;
  const saved: Record<string, string | undefined> = {
    RAIL_PRIMARY_URL: process.env.RAIL_PRIMARY_URL,
    RAIL_PRIMARY_TOKEN: process.env.RAIL_PRIMARY_TOKEN,
  };
  // Env lit with secrets the body must never carry; the BOUND transport is
  // what the route reports, and it serves rail_primary only.
  process.env.RAIL_PRIMARY_URL = `https://rail.example/${secret}`;
  process.env.RAIL_PRIMARY_TOKEN = secret;
  setRailTransport(scriptedRail({ name: "t", environment: "live", rails: ["rail_primary"] }));
  try {
    // rail_primary has a (closed) breaker row; rail_secondary has none at all.
    await getDb()
      .insert(railStatesTable)
      .values({ rail: "rail_primary" })
      .onConflictDoNothing({ target: railStatesTable.rail });
    await getDb()
      .update(railStatesTable)
      .set({ state: "closed", failureCount: 0, openedAt: null, retryAt: null })
      .where(eq(railStatesTable.rail, "rail_primary"));
    await getDb().delete(railStatesTable).where(eq(railStatesTable.rail, "rail_secondary"));

    const base = await listen(appFor(operator, operatorRouter));
    const res = await fetch(`${base}/operator/rails`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(secret), "no URL or token in the body");
    assert.ok(!text.includes("rail.example"), "no rail host in the body");
    const body = JSON.parse(text) as RailStateItem[];
    assert.deepEqual(
      body.map((r) => r.rail),
      ["rail_primary", "rail_secondary"],
      "exactly two rows, primary first",
    );
    const [primary, secondary] = body as [RailStateItem, RailStateItem];
    assert.equal(primary.transport, "t");
    assert.equal(primary.environment, "live");
    assert.equal(primary.configured, true);
    assert.equal(primary.state, "closed");
    assert.equal(secondary.transport, "t");
    assert.equal(secondary.environment, "live");
    assert.equal(secondary.configured, false, "a rail the transport does not serve");
    assert.equal(secondary.state, "closed", "synthesised closed: no rail_states row exists");
    assert.equal(secondary.failureCount, 0);
    assert.equal(secondary.openedAt, null);
    assert.equal(secondary.retryAt, null);
    assert.ok(
      body.every((r) => Object.values(r).every((v) => typeof v !== "string" || !v.includes(secret))),
      "no field carries the secret",
    );
  } finally {
    setRailTransport(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    // Put the lazily created row back so later suites start from a known row.
    await getDb()
      .insert(railStatesTable)
      .values({ rail: "rail_secondary" })
      .onConflictDoNothing({ target: railStatesTable.rail });
  }
});

test("every endpoint requires operator.queue.read (firm_admin is 403)", async () => {
  const base = await listen(appFor(firmAdmin, operatorRouter));
  assert.equal((await fetch(`${base}/operator/health-alerts`)).status, 403);
  assert.equal((await fetch(`${base}/operator/rail-config`)).status, 403);
  assert.equal((await fetch(`${base}/operator/rails`)).status, 403);
});
