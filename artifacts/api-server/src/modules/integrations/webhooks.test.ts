import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID, createHmac, createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLifecycleEventsTable,
  auditEventsTable,
  firmWebhooksTable,
  firmWebhookDeliveriesTable,
} from "@workspace/db";
import integrationsRouter from "../../routes/integrations.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  WEBHOOK_EVENTS,
  SIGNATURE_HEADER,
  createFirmWebhook,
  fanOutWebhookEvents,
  dispatchWebhookDeliveries,
  vetWebhookUrl,
  vetEvents,
} from "./webhooks.ts";
import {
  appFor,
  listen,
  closeAllServers,
  JSON_HEADERS,
} from "../../test-helpers/route-harness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Outbound firm webhooks: fan-out inserts pointer-only delivery rows for
// subscribed ACTIVE endpoints from the append-only domain ledgers
// (idempotent via the (webhook_id, event_key) unique index); the dispatcher
// POSTs with an HMAC signature and outbox retry semantics (failed → backoff
// → dead). Fixtures (firm/party/invoice/lifecycle/audit rows) are left
// behind like buyer.test.ts — the lifecycle and audit ledgers are
// append-only by design, so the invoice/firm spine they reference cannot be
// deleted; only the integration tables themselves are cleaned.

const SALT = makeRunSalt();
const firmA = randomUUID();
const firmB = randomUUID();
const partyA = randomUUID();
const invoiceA = randomUUID();
const statementId = randomUUID();

const admin: Principal = {
  userId: randomUUID(),
  role: "firm_admin",
  firmId: firmA,
  clientPartyId: null,
  buyerPartyId: null,
};
const staff: Principal = { ...admin, userId: randomUUID(), role: "firm_staff" };
const adminB: Principal = { ...admin, userId: randomUUID(), firmId: firmB };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Local receiver: /ok answers 200, /fail answers 500; every request's body,
// headers and path are captured.
interface Captured {
  path: string;
  body: string;
  headers: IncomingMessage["headers"];
}
const captured: Captured[] = [];
let receiver: Server;
let receiverBase = "";

before(async () => {
  receiver = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      captured.push({ path: req.url ?? "", body, headers: req.headers });
      res.statusCode = req.url === "/fail" ? 500 : 200;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    receiver.listen(0, "127.0.0.1", resolve);
  });
  receiverBase = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Webhook Firm A ${SALT}` },
    { id: firmB, name: `Webhook Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: partyA, type: "client_business", legalName: `Webhook Party ${SALT}` },
  ]);
  await db.insert(invoicesTable).values([
    {
      id: invoiceA,
      firmId: firmA,
      supplierPartyId: partyA,
      buyerPartyId: partyA,
      invoiceNumber: `WH-${SALT}`,
      issueDate: "2026-07-01",
    },
  ]);
});

after(async () => {
  await closeAllServers();
  await new Promise<void>((resolve, reject) =>
    receiver.close((err) => (err ? reject(err) : resolve())),
  );
  const db = getDb();
  for (const firm of [firmA, firmB]) {
    await db
      .delete(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.firmId, firm));
    await db
      .delete(firmWebhooksTable)
      .where(eq(firmWebhooksTable.firmId, firm));
  }
});

test("vetting: unknown events and bad URLs are rejected; production requires public https", () => {
  assert.throws(() => vetEvents(["invoice.stamped", "invoice.deleted"]));
  assert.deepEqual(vetEvents(["invoice.stamped", "invoice.stamped"]), ["invoice.stamped"]);
  assert.throws(() => vetWebhookUrl("not a url"));
  assert.throws(() => vetWebhookUrl("ftp://example.com/hook"));
  assert.equal(
    vetWebhookUrl("https://hooks.example.com/x"),
    "https://hooks.example.com/x",
  );
  const env = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(() => vetWebhookUrl("http://hooks.example.com/x"), /https/);
    assert.throws(() => vetWebhookUrl("https://127.0.0.1/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://localhost/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://10.0.0.8/x"), /public/);
    assert.throws(() => vetWebhookUrl("https://169.254.169.254/x"), /public/);
  } finally {
    process.env.NODE_ENV = env;
  }
});

test("fan-out inserts pointer-only deliveries for subscribed active webhooks only, idempotently", async () => {
  // Register the webhooks FIRST (fan-out only picks up events newer than the
  // registration), then commit the domain events.
  const all = await createFirmWebhook(firmA, "https://a.example.test/all", [...WEBHOOK_EVENTS]);
  const stampedOnly = await createFirmWebhook(firmA, "https://a.example.test/stamped", ["invoice.stamped"]);
  const inactive = await createFirmWebhook(firmA, "https://a.example.test/off", [...WEBHOOK_EVENTS]);
  await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(eq(firmWebhooksTable.id, inactive.row.id));
  const foreign = await createFirmWebhook(firmB, "https://b.example.test/all", [...WEBHOOK_EVENTS]);

  await getDb().insert(invoiceLifecycleEventsTable).values([
    { invoiceId: invoiceA, firmId: firmA, fromStatus: "submitted", toStatus: "stamped", actorRole: "system" },
    { invoiceId: invoiceA, firmId: firmA, fromStatus: "stamped", toStatus: "settled", actorRole: "system" },
    // A non-catalog transition must never fan out.
    { invoiceId: invoiceA, firmId: firmA, fromStatus: "draft", toStatus: "validated", actorRole: "system" },
  ]);
  await getDb().insert(auditEventsTable).values({
    firmId: firmA,
    action: "statement.reconciled",
    entityType: "bank_statement",
    entityId: statementId,
    after: { proposals: 1 },
    hash: `wh-test-${SALT}`,
    prevHash: `wh-test-${SALT}`,
  });

  const inserted = await fanOutWebhookEvents();
  assert.equal(inserted, 4, "3 events for the all-hook + 1 for the stamped-only hook");

  const deliveries = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(
      inArray(firmWebhookDeliveriesTable.webhookId, [
        all.row.id,
        stampedOnly.row.id,
        inactive.row.id,
        foreign.row.id,
      ]),
    );
  const byHook = (id: string) => deliveries.filter((d) => d.webhookId === id);
  assert.deepEqual(
    byHook(all.row.id).map((d) => d.eventType).sort(),
    ["invoice.settled", "invoice.stamped", "statement.reconciled"],
  );
  assert.deepEqual(byHook(stampedOnly.row.id).map((d) => d.eventType), ["invoice.stamped"]);
  assert.equal(byHook(inactive.row.id).length, 0, "inactive hooks receive nothing");
  assert.equal(byHook(foreign.row.id).length, 0, "another firm's events never cross");

  // SEC-12: payloads are pointer-only — entity type + id, nothing else.
  for (const d of deliveries) {
    assert.deepEqual(Object.keys(d.payload).sort(), ["entityId", "entityType"]);
    assert.equal(d.status, "pending");
    assert.equal(d.firmId, firmA);
  }
  const stampedDelivery = byHook(all.row.id).find((d) => d.eventType === "invoice.stamped");
  assert.deepEqual(stampedDelivery?.payload, { entityType: "invoice", entityId: invoiceA });
  const reconciled = byHook(all.row.id).find((d) => d.eventType === "statement.reconciled");
  assert.deepEqual(reconciled?.payload, { entityType: "bank_statement", entityId: statementId });

  // Idempotent: a second pass (concurrent sweep instance / window re-scan)
  // inserts nothing.
  assert.equal(await fanOutWebhookEvents(), 0);

  // A webhook registered AFTER the events never receives history.
  const late = await createFirmWebhook(firmA, "https://a.example.test/late", [...WEBHOOK_EVENTS]);
  assert.equal(await fanOutWebhookEvents(), 0);
  const lateRows = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, late.row.id));
  assert.equal(lateRows.length, 0);

  // Park these deliveries so the dispatcher tests below never try to POST to
  // the unroutable example hosts.
  await getDb()
    .update(firmWebhookDeliveriesTable)
    .set({ status: "dead" })
    .where(eq(firmWebhookDeliveriesTable.firmId, firmA));
});

test("dispatch signs the body with the stored hash and marks delivered", async () => {
  const hook = await createFirmWebhook(firmA, `${receiverBase}/ok`, ["invoice.stamped"]);
  assert.equal(hook.row.secretHash, sha256Hex(hook.secret), "stored hash is sha256(secret)");
  const [delivery] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.row.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:ok:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
    })
    .returning();

  captured.length = 0;
  const dispatched = await dispatchWebhookDeliveries();
  assert.equal(dispatched, 1);
  assert.equal(captured.length, 1);

  const [row] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.id, delivery.id))
    .limit(1);
  assert.equal(row.status, "delivered");
  assert.equal(row.attempts, 1);
  assert.ok(row.deliveredAt);
  assert.equal(row.lastError, null);

  // Body: pointer-only, exactly the documented shape.
  const body = JSON.parse(captured[0].body) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), [
    "createdAt",
    "entityId",
    "entityType",
    "eventType",
    "id",
  ]);
  assert.equal(body.id, delivery.id);
  assert.equal(body.eventType, "invoice.stamped");
  assert.equal(body.entityType, "invoice");
  assert.equal(body.entityId, invoiceA);

  // Signature: HMAC-SHA256 of the exact body bytes, keyed by sha256(secret)
  // — the receiver derives the key by hashing its stored secret once.
  const expected = createHmac("sha256", sha256Hex(hook.secret))
    .update(captured[0].body)
    .digest("hex");
  assert.equal(captured[0].headers[SIGNATURE_HEADER], expected);
  assert.equal(captured[0].headers["x-meridian-event"], "invoice.stamped");
});

test("dispatch retries with backoff and dead-letters after max attempts; disabled hooks are never claimed", async () => {
  const hook = await createFirmWebhook(firmA, `${receiverBase}/fail`, ["invoice.settled"]);
  const [delivery] = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.row.id,
      firmId: firmA,
      eventType: "invoice.settled",
      eventKey: `test:fail:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
    })
    .returning();

  // A pending delivery on a DISABLED hook is never claimed.
  const disabled = await createFirmWebhook(firmA, `${receiverBase}/ok`, ["invoice.settled"]);
  await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(eq(firmWebhooksTable.id, disabled.row.id));
  await getDb().insert(firmWebhookDeliveriesTable).values({
    webhookId: disabled.row.id,
    firmId: firmA,
    eventType: "invoice.settled",
    eventKey: `test:disabled:${SALT}`,
    payload: { entityType: "invoice", entityId: invoiceA },
  });

  captured.length = 0;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await dispatchWebhookDeliveries();
    const [row] = await getDb()
      .select()
      .from(firmWebhookDeliveriesTable)
      .where(eq(firmWebhookDeliveriesTable.id, delivery.id))
      .limit(1);
    assert.equal(row.attempts, attempt);
    assert.equal(row.lastError, "HTTP 500");
    if (attempt < 5) {
      assert.equal(row.status, "failed", `attempt ${attempt} retries`);
      // The claim pre-charged exponential backoff; fast-forward for the test.
      assert.ok(row.nextAttemptAt.getTime() > Date.now(), "backoff scheduled");
      await getDb()
        .update(firmWebhookDeliveriesTable)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
    } else {
      assert.equal(row.status, "dead", "gives up after max attempts");
    }
  }
  assert.equal(captured.length, 5, "exactly one POST per attempt");
  assert.ok(captured.every((c) => c.path === "/fail"), "disabled hook never POSTed");

  // Dead rows are out of the queue for good.
  await dispatchWebhookDeliveries();
  assert.equal(captured.length, 5);

  const [parked] = await getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, disabled.row.id))
    .limit(1);
  assert.equal(parked.status, "pending");
  assert.equal(parked.attempts, 0);
});

test("routes: create shows the secret once, disable is CAS, deliveries list newest first, firm_admin only", async () => {
  const base = await listen(appFor(admin, integrationsRouter));

  const created = await fetch(`${base}/firm-webhooks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      url: "https://hooks.example.test/route",
      events: ["invoice.stamped", "statement.reconciled"],
    }),
  });
  assert.equal(created.status, 201);
  const hook = (await created.json()) as {
    id: string;
    url: string;
    events: string[];
    active: boolean;
    secretPrefix: string;
    secret: string;
  };
  assert.match(hook.secret, /^whsec_[A-Za-z0-9_-]{32}$/);
  assert.equal(hook.secretPrefix, hook.secret.slice(0, 12));
  assert.equal(hook.active, true);
  assert.deepEqual(hook.events, ["invoice.stamped", "statement.reconciled"]);
  const [row] = await getDb()
    .select()
    .from(firmWebhooksTable)
    .where(eq(firmWebhooksTable.id, hook.id))
    .limit(1);
  assert.equal(row.secretHash, sha256Hex(hook.secret));

  // Unknown event fails closed.
  const bad = await fetch(`${base}/firm-webhooks`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url: "https://hooks.example.test/x", events: ["invoice.paid"] }),
  });
  assert.equal(bad.status, 400);

  // List: metadata only, never the secret or its hash.
  const list = await fetch(`${base}/firm-webhooks`);
  assert.equal(list.status, 200);
  const listBody = (await list.json()) as Record<string, unknown>[];
  assert.ok(listBody.some((w) => w.id === hook.id));
  assert.ok(!JSON.stringify(listBody).includes(hook.secret));
  assert.ok(!JSON.stringify(listBody).includes(row.secretHash));

  // Disable: CAS, idempotent, and 404 for a foreign firm.
  const disabled = await fetch(`${base}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(disabled.status, 200);
  assert.equal(((await disabled.json()) as { active: boolean }).active, false);
  const again = await fetch(`${base}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(again.status, 200);
  const foreignBase = await listen(appFor(adminB, integrationsRouter));
  const cross = await fetch(`${foreignBase}/firm-webhooks/${hook.id}/disable`, {
    method: "POST",
    headers: JSON_HEADERS,
  });
  assert.equal(cross.status, 404);
  const crossList = await fetch(`${foreignBase}/firm-webhooks/${hook.id}/deliveries`);
  assert.equal(crossList.status, 404);

  // Deliveries list, newest first.
  const early = await getDb()
    .insert(firmWebhookDeliveriesTable)
    .values({
      webhookId: hook.id,
      firmId: firmA,
      eventType: "invoice.stamped",
      eventKey: `test:list1:${SALT}`,
      payload: { entityType: "invoice", entityId: invoiceA },
      status: "delivered",
      createdAt: new Date(Date.now() - 60_000),
    })
    .returning();
  await getDb().insert(firmWebhookDeliveriesTable).values({
    webhookId: hook.id,
    firmId: firmA,
    eventType: "statement.reconciled",
    eventKey: `test:list2:${SALT}`,
    payload: { entityType: "bank_statement", entityId: statementId },
  });
  const deliveries = await fetch(`${base}/firm-webhooks/${hook.id}/deliveries`);
  assert.equal(deliveries.status, 200);
  const items = (await deliveries.json()) as { id: string; eventType: string }[];
  assert.equal(items.length, 2);
  assert.equal(items[0].eventType, "statement.reconciled");
  assert.equal(items[1].id, early[0].id);

  // Explicit role gate: staff (and any non-admin) is refused.
  const staffBase = await listen(appFor(staff, integrationsRouter));
  assert.equal((await fetch(`${staffBase}/firm-webhooks`)).status, 403);
});

test("RLS: webhook and delivery rows are firm-isolated at the data layer", async () => {
  const seenByB = await runRequestContext({ bypass: false, firmId: firmB }, async () => ({
    hooks: await getDb().select({ firmId: firmWebhooksTable.firmId }).from(firmWebhooksTable),
    deliveries: await getDb()
      .select({ firmId: firmWebhookDeliveriesTable.firmId })
      .from(firmWebhookDeliveriesTable),
  }));
  assert.ok(seenByB.hooks.every((r) => r.firmId === firmB));
  assert.ok(seenByB.deliveries.every((r) => r.firmId === firmB));

  const seenByA = await runRequestContext({ bypass: false, firmId: firmA }, () =>
    getDb().select({ firmId: firmWebhooksTable.firmId }).from(firmWebhooksTable),
  );
  assert.ok(seenByA.length > 0, "firm A sees its own webhooks");
  assert.ok(seenByA.every((r) => r.firmId === firmA));

  // WITH CHECK: firm B cannot write a delivery into firm A.
  await assert.rejects(
    runRequestContext({ bypass: false, firmId: firmB }, async () => {
      const [hook] = await getDb()
        .select({ id: firmWebhooksTable.id })
        .from(firmWebhooksTable)
        .where(eq(firmWebhooksTable.firmId, firmB))
        .limit(1);
      await getDb().insert(firmWebhookDeliveriesTable).values({
        webhookId: hook?.id ?? randomUUID(),
        firmId: firmA,
        eventType: "invoice.stamped",
        eventKey: `test:cross:${SALT}`,
        payload: { entityType: "invoice", entityId: invoiceA },
      });
    }),
  );
});
