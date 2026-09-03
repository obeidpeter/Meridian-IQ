import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
  outboxTable,
  railStatesTable,
  submissionAttemptsTable,
  type Rail,
} from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { setRailTransport } from "../rails/adapter.ts";
import { scriptedRail } from "../rails/transports/scripted.ts";
import {
  backoffMs,
  drain,
  reconcile,
  replayDead,
  retryDisposition,
  sweepOutboxGauges,
} from "./pipeline.ts";
import { registry } from "../../lib/metrics.ts";

// Outage policy (R96): a submission that meets an open breaker PARKS
// (nothing sent, no attempt burned, wake at the breaker's retry-at); a
// retriable rail error backs off with jitter under a wall-clock horizon and
// dead-letters only once both the horizon and the minimum tries are spent;
// reconcile never resurrects a dead row; a replay starts a fresh horizon;
// the gauges sweep exposes depth by state.

const SALT = makeRunSalt();
const firm = randomUUID();
const supplier = randomUUID();
const buyer = randomUUID();
const RAILS: Rail[] = ["rail_primary", "rail_secondary"];

// Every submit times out: the wildcard script applies to any invoice (R95
// scripted fake; a "timeout" answers RAIL_TIMEOUT without waiting).
const failingRail = scriptedRail({ name: "failing-rail" });
failingRail.script("*", { outcome: "timeout" });

async function seedInvoice(n: number) {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId: firm,
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: `INV-OUT-${n}-${SALT}`,
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    status: "submitted",
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
  });
  await getDb().insert(invoiceLinesTable).values({
    invoiceId: id,
    lineNo: 1,
    description: `Outage ${SALT}`,
    quantity: "1.0000",
    unitPrice: "100000.00",
    vatRate: "0.0750",
    lineExtension: "100000.00",
    vatAmount: "7500.00",
  });
  return id;
}

async function enqueue(invoiceId: string, maxAttempts = 6) {
  const [row] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "invoice",
      aggregateId: invoiceId,
      type: "invoice.submit",
      payload: { invoiceId },
      maxAttempts,
    })
    .returning({ id: outboxTable.id });
  return row!.id;
}

const outboxRow = async (id: string) =>
  (await getDb().select().from(outboxTable).where(eq(outboxTable.id, id)))[0]!;

async function setBreakers(state: "closed" | "open", retryAt: Date | null) {
  for (const rail of RAILS) {
    await getDb()
      .insert(railStatesTable)
      .values({ rail })
      .onConflictDoNothing({ target: railStatesTable.rail });
    await getDb()
      .update(railStatesTable)
      .set({
        state,
        failureCount: state === "open" ? 3 : 0,
        openedAt: state === "open" ? new Date(Date.now() - 10_000) : null,
        retryAt,
      })
      .where(eq(railStatesTable.rail, rail));
  }
}

// The scratch outbox is shared with every other suite: drain until this
// event has left the ready queue (settled, parked or backed off).
async function drainUntilScheduled(id: string) {
  for (let pass = 0; pass < 20; pass++) {
    const row = await outboxRow(id);
    const ready = row.status === "pending" && row.nextAttemptAt.getTime() <= Date.now();
    if (!ready && row.status !== "processing") return;
    if ((await drain(50)) === 0) return;
  }
}

before(async () => {
  await getDb().insert(firmsTable).values({ id: firm, name: `Outage Firm ${SALT}` });
  await getDb().insert(partiesTable).values([
    { id: supplier, type: "client_business", legalName: `Outage Supplier ${SALT}`, tin: "12345678-0001", street: "1 Marina", city: "Lagos", countryCode: "NG" },
    { id: buyer, type: "buyer", legalName: `Outage Buyer ${SALT}`, tin: "12345678-0002", street: "2 Marina", city: "Lagos", countryCode: "NG" },
  ]);
  await setBreakers("closed", null);
});

after(async () => {
  setRailTransport(null);
  delete process.env.OUTBOX_RETRY_HORIZON_MS;
  await setBreakers("closed", null);
});

test("backoff is capped and jittered; the disposition needs both the minimum tries and the horizon", () => {
  for (let i = 0; i < 20; i++) {
    const first = backoffMs(0);
    assert.ok(first >= 1_000 && first <= 2_000, `first backoff in [1s,2s]: ${first}`);
    const deep = backoffMs(30);
    assert.ok(deep >= 450_000 && deep <= 900_000, `deep backoff capped at 15 min: ${deep}`);
  }
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 25 * 60 * 60 * 1000);
  assert.equal(retryDisposition({ maxAttempts: 6, firstAttemptAt: dayAgo }, 6, now).dead, true);
  assert.equal(retryDisposition({ maxAttempts: 6, firstAttemptAt: dayAgo }, 5, now).dead, false, "minimum tries not yet spent");
  const fresh = retryDisposition({ maxAttempts: 6, firstAttemptAt: null }, 6, now);
  assert.equal(fresh.dead, false, "the horizon starts at the first attempt");
  assert.equal(fresh.firstAttemptAt, now);
  assert.ok(fresh.nextAttemptAt.getTime() > now.getTime());
});

test("every breaker open: the submission parks — nothing sent, no attempt burned, wake at retry-at", async () => {
  const retryAt = new Date(Date.now() + 60_000);
  await setBreakers("open", retryAt);
  const mustNotBeCalled = scriptedRail({ name: "must-not-be-called" });
  mustNotBeCalled.script("*", { outcome: "timeout" });
  setRailTransport(mustNotBeCalled);
  const invoiceId = await seedInvoice(1);
  const id = await enqueue(invoiceId);
  try {
    await drainUntilScheduled(id);
  } finally {
    setRailTransport(null);
  }
  const row = await outboxRow(id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0, "no attempt burned");
  assert.equal(row.parkCount, 1);
  assert.equal(row.firstAttemptAt, null, "the horizon clock has not started");
  assert.ok(row.parkedUntil && row.parkedUntil.getTime() >= retryAt.getTime());
  assert.ok(row.parkedUntil && row.parkedUntil.getTime() <= retryAt.getTime() + 2_500, "jitter is bounded");
  assert.equal(row.nextAttemptAt.getTime(), row.parkedUntil!.getTime());
  assert.match(row.lastError ?? "", /^RAIL_UNAVAILABLE: parked until /);
  assert.deepEqual(mustNotBeCalled.calls, [], "the rail was never called");
  const attempts = await getDb().select().from(submissionAttemptsTable).where(eq(submissionAttemptsTable.invoiceId, invoiceId));
  assert.equal(attempts.length, 0, "a park is not a submission attempt");
  const [inv] = await getDb().select({ status: invoicesTable.status }).from(invoicesTable).where(eq(invoicesTable.id, invoiceId));
  assert.equal(inv?.status, "submitted");
  await setBreakers("closed", null);
});

test("a retriable rail error backs off under the horizon; horizon + minimum tries spent dead-letters", async () => {
  setRailTransport(failingRail);
  try {
    delete process.env.OUTBOX_RETRY_HORIZON_MS;
    const invoiceA = await seedInvoice(2);
    const a = await enqueue(invoiceA, 1);
    const before = Date.now();
    await drainUntilScheduled(a);
    const rowA = await outboxRow(a);
    assert.equal(rowA.status, "pending", "one try with a day of horizon left stays pending");
    assert.equal(rowA.attempts, 1);
    assert.ok(rowA.firstAttemptAt && rowA.firstAttemptAt.getTime() >= before - 1_000);
    const delay = rowA.nextAttemptAt.getTime() - Date.now();
    assert.ok(delay >= 1_000 && delay <= 4_500, `jittered backoff for attempt 1: ${delay}ms`);
    assert.equal(rowA.lastError, "RAIL_TIMEOUT");
    await setBreakers("closed", null);

    process.env.OUTBOX_RETRY_HORIZON_MS = "0";
    const invoiceB = await seedInvoice(3);
    const b = await enqueue(invoiceB, 1);
    await drainUntilScheduled(b);
    const rowB = await outboxRow(b);
    assert.equal(rowB.status, "dead", "horizon spent and minimum tries done");
    assert.equal(rowB.attempts, 1);
    assert.ok(rowB.firstAttemptAt);
  } finally {
    delete process.env.OUTBOX_RETRY_HORIZON_MS;
    setRailTransport(null);
    await setBreakers("closed", null);
  }
});

test("reconcile never resurrects a dead-lettered submission; a replay restarts its horizon", async () => {
  const invoiceId = await seedInvoice(4);
  const [dead] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "invoice",
      aggregateId: invoiceId,
      type: "invoice.submit",
      payload: { invoiceId },
      status: "dead",
      attempts: 6,
      firstAttemptAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      parkCount: 3,
      lastError: "RAIL_TIMEOUT",
    })
    .returning({ id: outboxTable.id });
  setRailTransport(null);
  await reconcile();
  const rows = await getDb().select().from(outboxTable).where(eq(outboxTable.aggregateId, invoiceId));
  assert.equal(rows.length, 1, "no fresh row was queued beside the dead one");
  assert.equal(rows[0]!.status, "dead");

  await replayDead(dead!.id);
  const replayed = await outboxRow(dead!.id);
  assert.equal(replayed.status, "pending");
  assert.equal(replayed.attempts, 0);
  assert.equal(replayed.firstAttemptAt, null, "a replay starts a fresh horizon");
  assert.equal(replayed.parkCount, 0);
  assert.equal(replayed.lastError, null);
  // Settle it so the shared outbox does not carry a live row for this run.
  await drainUntilScheduled(dead!.id);
});

test("the gauges sweep exposes outbox depth by state and the oldest pending age", async () => {
  await sweepOutboxGauges();
  const text = await registry.metrics();
  for (const state of ["pending", "parked", "processing", "dead"]) {
    assert.match(text, new RegExp(`meridian_outbox_events\\{state="${state}"\\} \\d+`));
  }
  assert.match(text, /meridian_outbox_oldest_pending_age_seconds \d/);
});
