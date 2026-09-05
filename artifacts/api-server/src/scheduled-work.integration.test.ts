import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { randomUUID, createHash, createHmac } from "node:crypto";
import express from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  hasDatabaseContext,
  pool,
  firmsTable,
  partiesTable,
  usersTable,
  engagementsTable,
  consentRecordsTable,
  alertPreferencesTable,
  invoicesTable,
  invoiceLinesTable,
  outboxTable,
  stampRecordsTable,
  railStatesTable,
  obligationsTable,
  filingReturnsTable,
  whtCreditsTable,
  messagesTable,
  deadlineReminderSendsTable,
  obligationReminderSendsTable,
  filingReminderSendsTable,
  whtReminderSendsTable,
  firmWebhookDeliveriesTable,
} from "@workspace/db";
import { listen, closeAllServers } from "./test-helpers/route-harness.ts";
import { makeFlagGuard } from "./test-helpers/flags.ts";
import { lagosDateOffset } from "./test-helpers/fixtures.ts";
import { startFakeRail, type FakeRail } from "./modules/rails/fake-rail.ts";
import { createHttpRailTransport } from "./modules/rails/transports/http.ts";
import { setRailTransport } from "./modules/rails/adapter.ts";
import {
  createFirmWebhook,
  disableFirmWebhook,
  SIGNATURE_HEADER,
} from "./modules/integrations/webhooks.ts";
import {
  setMessageTransport,
  resetMessageTransport,
} from "./modules/messaging/messaging.ts";
import {
  runScheduledWorkOnce,
  registerSweep,
  unregisterSweep,
  listSweeps,
  stopWorker,
  resumeWorker,
  awaitWorkerIdle,
} from "./modules/pipeline/pipeline.ts";

const token = randomUUID();
const messaging = makeFlagGuard("messaging_notifications");
const clerkRuntime = makeFlagGuard("clerk_ai_runtime");
const environment = {
  NODE_ENV: "test",
  ENABLE_DEV_AUTH: "true",
  SWEEP_TOKEN: token,
  RATE_LIMIT_GENERAL_PER_MIN: "0",
};
const previous = new Map(
  Object.keys(environment).map((key) => [key, process.env[key]]),
);
const providerContexts: boolean[] = [];
const received: { body: string; signature: string | undefined }[] = [];
let base: string;
let receiverBase: string;
let rail: FakeRail;

before(async () => {
  for (const [key, value] of Object.entries(environment))
    process.env[key] = value;
  await messaging.saveAndSet(true);
  await clerkRuntime.saveAndSet(false);
  rail = await startFakeRail({ token });
  const transport = createHttpRailTransport({
    urls: { rail_primary: rail.url },
    tokens: { rail_primary: token },
    environment: "sandbox",
    timeoutMs: 2_000,
  });
  setRailTransport({
    ...transport,
    submit: async (...args) => {
      providerContexts.push(hasDatabaseContext());
      assert.equal(
        pool.totalCount - pool.idleCount,
        0,
        "rail I/O holds no application connection",
      );
      return transport.submit(...args);
    },
  });
  setMessageTransport(async () => {
    providerContexts.push(hasDatabaseContext());
    assert.equal(
      pool.totalCount - pool.idleCount,
      0,
      "message I/O holds no application connection",
    );
    return { ok: true, providerMessageId: randomUUID() };
  });
  await getDb()
    .insert(railStatesTable)
    .values({ rail: "rail_primary", state: "closed" })
    .onConflictDoUpdate({
      target: railStatesTable.rail,
      set: { state: "closed", failureCount: 0, openedAt: null, retryAt: null },
    });
  const receiver = express();
  receiver.use(express.text({ type: "*/*" }));
  receiver.post("/hook", (req, res) => {
    received.push({ body: req.body, signature: req.get(SIGNATURE_HEADER) });
    res.sendStatus(200);
  });
  receiverBase = await listen(receiver);
  const { default: app } = await import("./app.ts");
  base = await listen(app);
  // No timer can rescue an HTTP-triggered submission in this regression.
  stopWorker();
  assert.equal(await awaitWorkerIdle(2_000), true);
  resumeWorker();
});

after(async () => {
  stopWorker();
  await awaitWorkerIdle(2_000);
  await closeAllServers();
  await rail?.close();
  setRailTransport(null);
  resetMessageTransport();
  await messaging.restore();
  await clerkRuntime.restore();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fixture() {
  const firmId = randomUUID(),
    partyId = randomUUID(),
    userId = randomUUID();
  const invoiceId = randomUUID(),
    reminderId = randomUUID();
  const obligationId = randomUUID(),
    filingId = randomUUID(),
    creditId = randomUUID();
  await getDb()
    .insert(firmsTable)
    .values({ id: firmId, name: "Scheduler regression" });
  await getDb()
    .insert(usersTable)
    .values({ id: userId, email: `${userId}@test.local` });
  await getDb().insert(partiesTable).values({
    id: partyId,
    type: "client_business",
    legalName: "Scheduler fixture",
    tin: "10000000-0009",
    street: "1 Test Street",
    city: "Lagos",
  });
  await getDb().insert(engagementsTable).values({
    firmId,
    clientPartyId: partyId,
    type: "readiness_assessment",
    status: "open",
    title: "Scheduler fixture",
  });
  await getDb().insert(consentRecordsTable).values({
    partyId,
    layer: 1,
    action: "grant",
    scope: "compliance",
    basis: "contract",
    channel: "test",
  });
  await getDb().insert(alertPreferencesTable).values({
    clientPartyId: partyId,
    emailEnabled: true,
    whatsappEnabled: false,
    smsEnabled: false,
    pushEnabled: false,
    deadlineAlerts: true,
  });
  for (const id of [invoiceId, reminderId]) {
    await getDb()
      .insert(invoicesTable)
      .values({
        id,
        firmId,
        supplierPartyId: partyId,
        buyerPartyId: partyId,
        invoiceNumber: `SCHED-${id}`,
        issueDate: lagosDateOffset(id === reminderId ? -8 : 0),
        subtotal: "1000.00",
        vatTotal: "75.00",
        grandTotal: "1075.00",
      });
    await getDb().insert(invoiceLinesTable).values({
      invoiceId: id,
      lineNo: 1,
      description: "Fixture service",
      quantity: "1",
      unitPrice: "1000",
      vatRate: "0.075",
      lineExtension: "1000",
      vatAmount: "75",
    });
  }
  await getDb()
    .insert(obligationsTable)
    .values({
      id: obligationId,
      firmId,
      clientPartyId: partyId,
      noticeType: "assessment",
      authority: "firs",
      responseDueDate: lagosDateOffset(-1),
      createdBy: userId,
    });
  await getDb()
    .insert(filingReturnsTable)
    .values({
      id: filingId,
      firmId,
      clientPartyId: partyId,
      taxType: "vat",
      period: "2098-01",
      dueDate: lagosDateOffset(-1),
    });
  await getDb()
    .insert(whtCreditsTable)
    .values({
      id: creditId,
      firmId,
      clientPartyId: partyId,
      invoiceId,
      category: "professional_services",
      amount: "50",
      deductedDate: lagosDateOffset(-31),
      source: "manual",
    });
  const hook = await createFirmWebhook(firmId, `${receiverBase}/hook`, [
    "invoice.stamped",
  ]);
  await getDb()
    .update(invoicesTable)
    .set({ status: "submitted" })
    .where(eq(invoicesTable.id, invoiceId));
  await getDb().insert(outboxTable).values({
    aggregateType: "invoice",
    aggregateId: invoiceId,
    type: "invoice.submit",
    payload: { invoiceId },
  });
  return {
    firmId,
    partyId,
    invoiceId,
    reminderId,
    obligationId,
    filingId,
    creditId,
    hook,
  };
}

async function httpPass() {
  const response = await fetch(`${base}/api/internal/sweep`, {
    headers: { "x-op-token": token },
  });
  const body = (await response.json()) as { status: string };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.status, "ok");
}

for (const mode of ["http", "background"] as const) {
  test(`${mode} scheduled pass stamps, signs webhooks and sends all four reminders without DB contexts around I/O`, async () => {
    const f = await fixture();
    const pass =
      mode === "http"
        ? httpPass
        : async () => {
            const result = await runScheduledWorkOnce();
            assert.deepEqual(result.failed, {
              drain: false,
              reconcile: false,
              sweeps: 0,
            });
          };
    const reminderNames = [
      "invoice.deadline_reminders",
      "obligations.reminders",
      "filings.reminders",
      "wht.reminders",
    ];
    for (const name of reminderNames)
      assert.ok(listSweeps().some((sweep) => sweep.name === name));
    try {
      // Sweeps precede drain: a second pass fans out the stamp just committed.
      await pass();
      await pass();
      const [stamp] = await getDb()
        .select()
        .from(stampRecordsTable)
        .where(eq(stampRecordsTable.invoiceId, f.invoiceId));
      assert.equal(stamp?.provider, "http");
      const calls = rail.calls.filter(
        (call) => call.invoiceNumber === `SCHED-${f.invoiceId}`,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].authorized, true);
      const event = received.find(
        (row) => JSON.parse(row.body).entityId === f.invoiceId,
      );
      assert.ok(event);
      const key = createHash("sha256").update(f.hook.secret).digest("hex");
      assert.equal(
        event.signature,
        createHmac("sha256", key).update(event.body).digest("hex"),
      );
      const payload = JSON.parse(event.body);
      for (const field of ["lines", "total", "amountNgn", "legalName", "tin"])
        assert.equal(field in payload, false);
      const delivery = await getDb()
        .select()
        .from(firmWebhookDeliveriesTable)
        .where(eq(firmWebhookDeliveriesTable.webhookId, f.hook.row.id));
      assert.equal(delivery.length, 1);
      assert.equal(delivery[0].status, "delivered");
      for (const [table, column, id] of [
        [
          deadlineReminderSendsTable,
          deadlineReminderSendsTable.invoiceId,
          f.reminderId,
        ],
        [
          obligationReminderSendsTable,
          obligationReminderSendsTable.obligationId,
          f.obligationId,
        ],
        [
          filingReminderSendsTable,
          filingReminderSendsTable.filingId,
          f.filingId,
        ],
        [whtReminderSendsTable, whtReminderSendsTable.creditId, f.creditId],
      ] as const) {
        const rows = await getDb()
          .select({ id: table.id })
          .from(table)
          .where(eq(column, id));
        assert.equal(rows.length, 1, `one claim for ${id}`);
      }
      const messages = await getDb()
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.recipientPartyId, f.partyId),
            eq(messagesTable.channel, "email"),
          ),
        );
      assert.deepEqual(messages.map((row) => row.templateKey).sort(), [
        "deadline_reminder",
        "filing_overdue",
        "obligation_overdue",
        "wht_note_overdue",
      ]);
      assert.ok(providerContexts.length >= 5);
      assert.ok(messages.every((row) => row.status === "sent"));
      assert.ok(
        providerContexts.every((context) => context === false),
        "no provider I/O holds a DB context",
      );
      await pass();
      assert.equal(
        received.filter((row) => JSON.parse(row.body).entityId === f.invoiceId)
          .length,
        1,
      );
      assert.equal(
        (
          await getDb()
            .select()
            .from(messagesTable)
            .where(eq(messagesTable.recipientPartyId, f.partyId))
        ).length,
        4,
      );
    } finally {
      await disableFirmWebhook(f.firmId, f.hook.row.id);
    }
  });
}

test("HTTP reports partial failure without clearing success evidence; healthy siblings still run", async () => {
  let siblings = 0;
  registerSweep("test.http-failure", async () => {
    throw new Error("private-fixture-detail");
  });
  registerSweep("test.http-sibling", async () => {
    siblings++;
  });
  const before = await pool.query(
    "SELECT last_succeeded_at FROM operational_heartbeats WHERE key = 'scheduled_work'",
  );
  try {
    const response = await fetch(`${base}/api/internal/sweep`, {
      headers: { "x-op-token": token },
    });
    const body = (await response.json()) as {
      status: string;
      failed: { sweeps: number };
    };
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(body.status, "partial_failure");
    assert.equal(body.failed.sweeps, 1);
    assert.equal(siblings, 1);
    assert.ok(!JSON.stringify(body).includes("private-fixture-detail"));
    const after = await pool.query(
      "SELECT last_succeeded_at, last_failed_at, last_error, metadata FROM operational_heartbeats WHERE key = 'scheduled_work'",
    );
    assert.deepEqual(
      after.rows[0].last_succeeded_at,
      before.rows[0].last_succeeded_at,
    );
    assert.ok(after.rows[0].last_failed_at);
    assert.equal(after.rows[0].metadata.failed.sweeps, 1);
  } finally {
    unregisterSweep("test.http-failure");
    unregisterSweep("test.http-sibling");
    await awaitWorkerIdle(2_000);
  }
});

test("HTTP skipped passes return busy and cannot overwrite a failed heartbeat", async () => {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(991102)");
    const response = await fetch(`${base}/api/internal/sweep`, {
      headers: { "x-op-token": token },
    });
    const body = (await response.json()) as {
      status: string;
      ran: { sweeps: boolean };
    };
    assert.equal(response.status, 202);
    assert.equal(body.status, "busy");
    assert.equal(body.ran.sweeps, false);
    const result = await getDb().execute(
      sql`SELECT last_error FROM operational_heartbeats WHERE key = 'scheduled_work'`,
    );
    assert.equal(result.rows[0].last_error, "Scheduled work partially failed");
  } finally {
    await lock.query("SELECT pg_advisory_unlock(991102)");
    lock.release();
  }
});
