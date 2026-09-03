import { test, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
  invoiceLifecycleEventsTable,
  operatorCasesTable,
  outboxTable,
  stampRecordsTable,
  submissionAttemptsTable,
  auditEventsTable,
  railStatesTable,
  type Rail,
} from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  breakerStatus,
  setRailTransport,
  type RailTransport,
} from "../rails/adapter.ts";
import { scriptedRail, type ScriptedRail } from "../rails/transports/scripted.ts";
import { drain, reconcile } from "./pipeline.ts";

// The rail fault matrix (R95), pinned end to end against a real Postgres: one
// named test per cell of outcome × pipeline disposition. Each cell binds the
// scripted fake — the same fault vocabulary the conformance fake-rail server
// speaks on the wire — and asserts what the pipeline leaves behind: the
// invoice status, the lifecycle transition and its reason, the audit action,
// one submission_attempts row per rail actually CALLED in a try, the outbox
// disposition (done / retry / dead), the breaker counters and the Compliance
// Desk case a dead row opens.
//
//   cell  outcome                     errorCode           disposition
//    1    reject(MBS_INVALID_TIN)     MBS_INVALID_TIN     dead: invoice failed, invoice.rejected, Desk case
//    2    rate_limit (both rails)     RAIL_RATE_LIMITED   retry: pending, invoice stays submitted
//    3    unavailable then accept     RAIL_UNAVAILABLE    failover: stamped via rail_secondary, both attempts kept
//    4    timeout (both rails)        RAIL_TIMEOUT        retry: both breakers count
//    5    unauthorized                RAIL_UNAUTHORIZED   retry: the platform's fault, invoice NOT failed
//    6    malformed                   RAIL_PROTOCOL       retry
//    7    non-retriable transport err MBS_SCHEMA_INVALID  dead WITHOUT invoice.rejected; failover stops
//    8    rail_primary breaker open   —                   the refusal is not an attempt; rail_secondary stamps
//    9    unavailable ×2 then accept  RAIL_UNAVAILABLE    retry, then stamped on the replayed backoff
//   10    transport throws once       "boom"              rolled back: no partial rows; retry stamps once
//   11    duplicate (stamp held)      MBS_DUPLICATE       recovered: invoice.stamp_recovered
//   12    reconcile vs a parked row   —                   a live parked row is never re-queued

const SALT = makeRunSalt();
const firm = randomUUID();
const supplier = randomUUID();
const buyer = randomUUID();
const RAILS: Rail[] = ["rail_primary", "rail_secondary"];
const FAKE = "matrix-rail";

const invoiceNumber = (n: number) => `INV-MATRIX-${n}-${SALT}`;

async function seedInvoice(n: number) {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId: firm,
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: invoiceNumber(n),
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
    description: `Matrix ${SALT}`,
    quantity: "1.0000",
    unitPrice: "100000.00",
    vatRate: "0.0750",
    lineExtension: "100000.00",
    vatAmount: "7500.00",
  });
  return id;
}

async function enqueueSubmit(invoiceId: string): Promise<string> {
  const [row] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "invoice",
      aggregateId: invoiceId,
      type: "invoice.submit",
      payload: { invoiceId },
    })
    .returning({ id: outboxTable.id });
  return row!.id;
}

/**
 * Drain the shared outbox until this invoice's event has settled or left the
 * ready queue (done, dead, or pending again with its backoff in the future).
 * The scratch DB is shared with every other suite, so the event is not
 * necessarily among the first few ready rows; drain in passes.
 */
async function drainUntilSettled(invoiceId: string) {
  for (let pass = 0; pass < 20; pass++) {
    const [row] = await getDb()
      .select({ status: outboxTable.status, nextAttemptAt: outboxTable.nextAttemptAt })
      .from(outboxTable)
      .where(eq(outboxTable.aggregateId, invoiceId));
    const ready =
      row?.status === "pending" && row.nextAttemptAt.getTime() <= Date.now();
    if (row && !ready && row.status !== "processing") return;
    if ((await drain(50)) === 0) return;
  }
}

/** The invoice's one outbox row (a cell that produced two would be a defect). */
async function outboxRow(invoiceId: string) {
  const rows = await getDb()
    .select()
    .from(outboxTable)
    .where(eq(outboxTable.aggregateId, invoiceId));
  assert.equal(rows.length, 1, "exactly one outbox row per submission");
  return rows[0]!;
}

const invoiceStatus = async (id: string) =>
  (await getDb().select({ status: invoicesTable.status }).from(invoicesTable).where(eq(invoicesTable.id, id)))[0]?.status;

// Rows of one try share a transaction, hence a created_at; order by the
// facts a reader cares about instead.
const attemptRows = async (id: string) =>
  getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, id))
    .orderBy(
      asc(submissionAttemptsTable.attemptNo),
      asc(submissionAttemptsTable.rail),
      asc(submissionAttemptsTable.status),
    );

const attemptShape = (rows: Awaited<ReturnType<typeof attemptRows>>) =>
  rows.map((a) => [a.rail, a.status, a.errorCode, a.attemptNo]);

const lifecycleRows = async (id: string) =>
  getDb()
    .select()
    .from(invoiceLifecycleEventsTable)
    .where(eq(invoiceLifecycleEventsTable.invoiceId, id))
    .orderBy(asc(invoiceLifecycleEventsTable.createdAt));

const auditActions = async (id: string) =>
  (
    await getDb()
      .select({ action: auditEventsTable.action })
      .from(auditEventsTable)
      .where(eq(auditEventsTable.entityId, id))
      .orderBy(asc(auditEventsTable.seq))
  ).map((r) => r.action);

const casesFor = async (id: string) =>
  getDb().select().from(operatorCasesTable).where(eq(operatorCasesTable.invoiceId, id));

const stampFor = async (id: string) =>
  (await getDb().select().from(stampRecordsTable).where(eq(stampRecordsTable.invoiceId, id)))[0];

/** The fake's call log for one invoice (other suites' stuck rows drain through it too). */
const callsFor = (fake: ScriptedRail, n: number) =>
  fake.calls
    .filter((c) => c.invoiceNumber === invoiceNumber(n))
    .map((c) => ({ op: c.op, rail: c.rail, outcome: c.outcome }));

/** Replay a backoff: make the row ready now. */
async function rewind(outboxId: string) {
  const past = new Date(Date.now() - 1_000);
  await getDb()
    .update(outboxTable)
    .set({ nextAttemptAt: past, parkedUntil: null })
    .where(eq(outboxTable.id, outboxId));
}

/**
 * A retry cell leaves its row pending with a backoff a few seconds out. Let
 * it succeed on a replayed backoff so the invoice and its row end settled
 * (stamped, done) rather than as a live row a later cell's drain — under that
 * cell's transport — would pick up.
 */
async function settleRetry(fake: ScriptedRail, invoiceId: string, outboxId: string) {
  fake.reset();
  await rewind(outboxId);
  await drainUntilSettled(invoiceId);
  assert.equal(await invoiceStatus(invoiceId), "stamped", "the replayed backoff stamps");
  assert.equal((await outboxRow(invoiceId)).status, "done");
}

async function setBreaker(
  rail: Rail,
  patch: { state: "closed" | "open"; failureCount: number; openedAt: Date | null; retryAt: Date | null },
) {
  await getDb()
    .insert(railStatesTable)
    .values({ rail })
    .onConflictDoNothing({ target: railStatesTable.rail });
  await getDb().update(railStatesTable).set(patch).where(eq(railStatesTable.rail, rail));
}

async function closeBreakers(): Promise<void> {
  for (const rail of RAILS) {
    await setBreaker(rail, { state: "closed", failureCount: 0, openedAt: null, retryAt: null });
  }
}

/** One retriable outcome on both rails: the shared shape of cells 2, 4, 5 and 6. */
async function runRetryCell(n: number, outcome: "rate_limit" | "timeout" | "unauthorized" | "malformed", code: string) {
  const id = await seedInvoice(n);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(n), { outcome });
  setRailTransport(fake);
  const before = Date.now();
  await drainUntilSettled(id);

  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "pending", "a retriable error re-queues");
  assert.equal(row.attempts, 1);
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), "backed off into the future");
  assert.ok(row.firstAttemptAt && row.firstAttemptAt.getTime() >= before - 1_000, "the horizon clock started");
  assert.equal(row.parkCount, 0, "a rail answer is not a park");
  assert.equal(row.lastError, code);
  assert.equal(await invoiceStatus(id), "submitted", "the invoice is NOT failed");
  assert.equal(await stampFor(id), undefined);
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [
      ["rail_primary", "error", code, 1],
      ["rail_secondary", "error", code, 1],
    ],
    "one error row per rail called, both on the same try",
  );
  assert.deepEqual(
    callsFor(fake, n).map((c) => c.rail),
    ["rail_primary", "rail_secondary"],
    "failover tried the second rail",
  );
  assert.equal((await lifecycleRows(id)).length, 0, "no lifecycle transition");
  assert.deepEqual(await auditActions(id), [], "no audit action for a retry");
  assert.equal((await casesFor(id)).length, 0, "no Desk case for a retry");
  return { id, outboxId, fake };
}

before(async () => {
  await closeBreakers();
  await getDb().insert(firmsTable).values({ id: firm, name: `Matrix Firm ${SALT}` });
  await getDb().insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `Matrix Supplier ${SALT}`,
      tin: `3333-${SALT}`,
      street: "1 Broad Street",
      city: "Lagos",
      countryCode: "NG",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Matrix Buyer ${SALT}`,
      tin: `4444-${SALT}`,
      street: "2 Marina",
      city: "Lagos",
      countryCode: "NG",
    },
  ]);
});

// Every cell starts from closed breakers so its failure counts are exact, and
// leaves no transport bound.
beforeEach(async () => {
  await closeBreakers();
});

afterEach(async () => {
  setRailTransport(null);
  await closeBreakers();
});

after(async () => {
  setRailTransport(null);
  await closeBreakers();
});

test("cell 1 — reject MBS_INVALID_TIN: invoice failed with the code as lifecycle reason, invoice.rejected, one rejected attempt, dead row, one Desk case", async () => {
  const id = await seedInvoice(1);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(1), { outcome: "reject", code: "MBS_INVALID_TIN" });
  setRailTransport(fake);
  await drainUntilSettled(id);

  assert.equal(await invoiceStatus(id), "failed");
  assert.equal(await stampFor(id), undefined);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.fromStatus, "submitted");
  assert.equal(lifecycle[0]?.toStatus, "failed");
  assert.equal(lifecycle[0]?.reason, "MBS_INVALID_TIN", "the rejection code is the transition reason");
  assert.equal(lifecycle[0]?.actorRole, "system");
  const actions = await auditActions(id);
  assert.equal(actions.filter((a) => a === "invoice.rejected").length, 1, actions.join(","));
  assert.deepEqual(attemptShape(await attemptRows(id)), [["rail_primary", "rejected", "MBS_INVALID_TIN", 1]]);
  assert.deepEqual(callsFor(fake, 1), [{ op: "submit", rail: "rail_primary", outcome: "reject" }], "a rejection never fails over");

  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "dead");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "MBS_INVALID_TIN");

  const cases = await casesFor(id);
  assert.equal(cases.length, 1, "exactly one Desk case");
  assert.equal(cases[0]?.errorCode, "MBS_INVALID_TIN");
  assert.equal(cases[0]?.priority, "high");
  assert.equal(cases[0]?.status, "open");
  assert.equal(cases[0]?.firmId, firm);
  assert.ok(cases[0]?.title.includes("failed: MBS_INVALID_TIN"), cases[0]?.title);
  assert.ok(cases[0]?.title.startsWith(invoiceNumber(1)), cases[0]?.title);
});

test("cell 2 — rate_limit on both rails: retry with backoff, invoice stays submitted, two RAIL_RATE_LIMITED attempts on one try", async () => {
  const { id, outboxId, fake } = await runRetryCell(2, "rate_limit", "RAIL_RATE_LIMITED");
  for (const rail of RAILS) {
    assert.equal((await breakerStatus(rail)).failureCount, 1, `${rail} counted the rate limit`);
  }
  await settleRetry(fake, id, outboxId);
});

test("cell 3 — unavailable on rail_primary then accept: stamped via rail_secondary, both attempts on record, primary breaker counts one", async () => {
  const id = await seedInvoice(3);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(3), { outcome: "unavailable", times: 1 });
  setRailTransport(fake);
  await drainUntilSettled(id);

  assert.equal(await invoiceStatus(id), "stamped");
  const stamp = await stampFor(id);
  assert.equal(stamp?.rail, "rail_secondary", "the failover rail issued the stamp");
  assert.equal(stamp?.provider, FAKE);
  assert.equal(stamp?.environment, "sandbox");
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [
      ["rail_primary", "error", "RAIL_UNAVAILABLE", 1],
      ["rail_secondary", "accepted", null, 1],
    ],
    "the failed first rail stays on the record beside the accepted one, same try",
  );
  assert.deepEqual(
    callsFor(fake, 3).map((c) => c.rail),
    ["rail_primary", "rail_secondary"],
  );
  const primary = await breakerStatus("rail_primary");
  assert.equal(primary.state, "closed");
  assert.equal(primary.failureCount, 1, "one transient failure counted against rail_primary");
  const secondary = await breakerStatus("rail_secondary");
  assert.equal(secondary.state, "closed");
  assert.equal(secondary.failureCount, 0);

  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 1);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.toStatus, "stamped");
  assert.equal(lifecycle[0]?.reason, "rail:rail_secondary");
  assert.ok((await auditActions(id)).includes("invoice.stamped"));
});

test("cell 4 — timeout on both rails: retry with RAIL_TIMEOUT, both breakers count one", async () => {
  const { id, outboxId, fake } = await runRetryCell(4, "timeout", "RAIL_TIMEOUT");
  for (const rail of RAILS) {
    const breaker = await breakerStatus(rail);
    assert.equal(breaker.state, "closed", `${rail} is still under the threshold`);
    assert.equal(breaker.failureCount, 1, `${rail} counted the timeout`);
  }
  await settleRetry(fake, id, outboxId);
});

test("cell 5 — unauthorized: retry with RAIL_UNAUTHORIZED, the invoice is NOT failed", async () => {
  const { id, outboxId, fake } = await runRetryCell(5, "unauthorized", "RAIL_UNAUTHORIZED");
  await settleRetry(fake, id, outboxId);
});

test("cell 6 — malformed answer: retry with RAIL_PROTOCOL", async () => {
  const { id, outboxId, fake } = await runRetryCell(6, "malformed", "RAIL_PROTOCOL");
  await settleRetry(fake, id, outboxId);
});

test("cell 7 — non-retriable transport error (MBS_SCHEMA_INVALID as status error): failover stops at rail_primary, invoice failed without invoice.rejected, dead row, Desk case", async () => {
  const id = await seedInvoice(7);
  const outboxId = await enqueueSubmit(id);
  // Only a custom transport can answer a terminal code as a transport ERROR
  // (the fault table carries it as a rejection). Other invoices draining
  // through this pass are accepted by the inner fake.
  const inner = scriptedRail({ name: "schema-rail" });
  const calls: Rail[] = [];
  const transport: RailTransport = {
    name: "schema-rail",
    environment: "sandbox",
    async submit(rail, inv, key) {
      if (inv.invoiceNumber !== invoiceNumber(7)) return inner.submit(rail, inv, key);
      calls.push(rail);
      return { status: "error", rail, errorCode: "MBS_SCHEMA_INVALID", raw: {} };
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(transport);
  await drainUntilSettled(id);

  assert.deepEqual(calls, ["rail_primary"], "a non-retriable error does not fail over");
  assert.equal(await invoiceStatus(id), "failed");
  assert.equal(await stampFor(id), undefined);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.fromStatus, "submitted");
  assert.equal(lifecycle[0]?.toStatus, "failed");
  assert.equal(lifecycle[0]?.reason, "MBS_SCHEMA_INVALID");
  const actions = await auditActions(id);
  assert.ok(!actions.includes("invoice.rejected"), `no business rejection was audited: ${actions.join(",")}`);
  assert.deepEqual(attemptShape(await attemptRows(id)), [["rail_primary", "error", "MBS_SCHEMA_INVALID", 1]]);

  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "dead");
  assert.equal(row.lastError, "MBS_SCHEMA_INVALID");
  const cases = await casesFor(id);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.errorCode, "MBS_SCHEMA_INVALID");
  assert.equal(cases[0]?.priority, "high");
  const secondary = await breakerStatus("rail_secondary");
  assert.equal(secondary.failureCount, 0, "rail_secondary was never touched");
});

test("cell 8 — rail_primary breaker open, rail_secondary closed: the refusal is not an attempt; stamped via rail_secondary; primary stays open", async () => {
  const id = await seedInvoice(8);
  const outboxId = await enqueueSubmit(id);
  const retryAt = new Date(Date.now() + 60_000);
  await setBreaker("rail_primary", {
    state: "open",
    failureCount: 3,
    openedAt: new Date(Date.now() - 10_000),
    retryAt,
  });
  const fake = scriptedRail({ name: FAKE });
  setRailTransport(fake);
  await drainUntilSettled(id);

  assert.equal(await invoiceStatus(id), "stamped");
  assert.equal((await stampFor(id))?.rail, "rail_secondary");
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [["rail_secondary", "accepted", null, 1]],
    "exactly one attempt: a breaker refusal sent nothing",
  );
  assert.deepEqual(callsFor(fake, 8), [{ op: "submit", rail: "rail_secondary", outcome: "accept" }]);
  const primary = await breakerStatus("rail_primary");
  assert.equal(primary.state, "open", "the refused breaker is untouched");
  assert.equal(primary.failureCount, 3);
  assert.equal(primary.retryAt?.getTime(), retryAt.getTime());
  const secondary = await breakerStatus("rail_secondary");
  assert.deepEqual([secondary.state, secondary.failureCount], ["closed", 0]);

  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 1);
  assert.equal(row.parkCount, 0, "one open breaker is not a full outage, so no park");
});

test("cell 9 — unavailable ×2 then accept across retries: pending after the first try, stamped on the replayed backoff, attempts numbered 1,1,2", async () => {
  const id = await seedInvoice(9);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(9), { outcome: "unavailable", times: 2 });
  setRailTransport(fake);
  await drainUntilSettled(id);

  let row = await outboxRow(id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "RAIL_UNAVAILABLE");
  assert.ok(row.nextAttemptAt.getTime() > Date.now());
  assert.equal(await invoiceStatus(id), "submitted");
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [
      ["rail_primary", "error", "RAIL_UNAVAILABLE", 1],
      ["rail_secondary", "error", "RAIL_UNAVAILABLE", 1],
    ],
  );

  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.equal((await stampFor(id))?.rail, "rail_primary");
  const attempts = await attemptRows(id);
  assert.deepEqual(
    attempts.map((a) => a.attemptNo),
    [1, 1, 2],
    "attemptNo is the try, shared by the rows of one try",
  );
  assert.deepEqual(attemptShape(attempts)[2], ["rail_primary", "accepted", null, 2]);
  assert.deepEqual(
    callsFor(fake, 9).map((c) => `${c.rail}:${c.outcome}`),
    ["rail_primary:unavailable", "rail_secondary:unavailable", "rail_primary:accept"],
  );
  assert.equal((await breakerStatus("rail_primary")).failureCount, 0, "the success reset rail_primary");
  assert.equal((await breakerStatus("rail_secondary")).failureCount, 1, "rail_secondary still carries its one failure");
  assert.equal((await lifecycleRows(id)).length, 1);
});

test("cell 10 — transport throws once then accepts: the try is rolled back (no attempt, lifecycle or audit rows), retried with backoff, then stamped exactly once", async () => {
  const id = await seedInvoice(10);
  const outboxId = await enqueueSubmit(id);
  const inner = scriptedRail({ name: "flaky-rail" });
  let thrown = false;
  const flaky: RailTransport = {
    name: "flaky-rail",
    environment: "sandbox",
    async submit(rail, inv, key) {
      if (!thrown && inv.invoiceNumber === invoiceNumber(10)) {
        thrown = true;
        throw new Error("boom");
      }
      return inner.submit(rail, inv, key);
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(flaky);
  await drainUntilSettled(id);

  assert.equal(thrown, true, "the throw hit this invoice");
  let row = await outboxRow(id);
  assert.equal(row.status, "pending", "the claim was rolled back and the row re-queued");
  assert.equal(row.attempts, 1, "the failed try still counts");
  assert.equal(row.lastError, "boom");
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), "backed off");
  assert.ok(row.firstAttemptAt, "the horizon clock started");
  assert.equal(row.parkCount, 0);
  assert.equal(await invoiceStatus(id), "submitted");
  assert.equal((await attemptRows(id)).length, 0, "no attempt row survives a rolled-back try");
  assert.equal((await lifecycleRows(id)).length, 0, "no lifecycle row survives a rolled-back try");
  assert.deepEqual(await auditActions(id), [], "no audit row survives a rolled-back try");
  assert.equal(await stampFor(id), undefined);
  assert.deepEqual(callsFor(inner, 10), [], "the inner fake never saw the failed try");

  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.deepEqual(attemptShape(await attemptRows(id)), [["rail_primary", "accepted", null, 2]]);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1, "exactly one lifecycle transition");
  assert.equal(lifecycle[0]?.fromStatus, "submitted");
  assert.equal(lifecycle[0]?.toStatus, "stamped");
  const actions = await auditActions(id);
  assert.deepEqual(actions, ["invoice.stamped"], "exactly one invoice.stamped, no duplicate rows");
  assert.deepEqual(callsFor(inner, 10), [{ op: "submit", rail: "rail_primary", outcome: "accept" }]);
});

test("cell 11 — duplicate with the stamp held: recovered — stamp persisted, invoice.stamp_recovered, rejected and lookup attempts both retained", async () => {
  const id = await seedInvoice(11);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(11), { outcome: "duplicate", holdsStamp: true });
  setRailTransport(fake);
  await drainUntilSettled(id);

  assert.equal(await invoiceStatus(id), "stamped");
  const stamp = await stampFor(id);
  assert.equal(stamp?.rail, "rail_primary", "the rail that reported the duplicate held the stamp");
  assert.equal(stamp?.provider, FAKE);
  assert.match(stamp?.irn ?? "", /^IRN-[0-9A-F]{16}$/, "the fake mints a simulator-shaped stamp");
  const attempts = await attemptRows(id);
  assert.deepEqual(attemptShape(attempts), [
    ["rail_primary", "accepted", null, 1],
    ["rail_primary", "rejected", "MBS_DUPLICATE", 1],
  ]);
  const lookup = attempts.find((a) => a.status === "accepted");
  assert.equal((lookup?.requestPayload as { lookup?: boolean })?.lookup, true);
  assert.equal((lookup?.responsePayload as { recovered?: boolean })?.recovered, true);
  const rejected = attempts.find((a) => a.status === "rejected");
  assert.ok((rejected?.requestPayload as { canonical?: unknown })?.canonical, "the rejected try retains the request sent");
  assert.deepEqual(callsFor(fake, 11), [
    { op: "submit", rail: "rail_primary", outcome: "duplicate" },
    { op: "lookup", rail: "rail_primary", outcome: "lookup_hit" },
  ]);
  const actions = await auditActions(id);
  assert.ok(actions.includes("invoice.stamp_recovered"), actions.join(","));
  assert.ok(!actions.includes("invoice.rejected"));
  assert.ok(!actions.includes("invoice.stamp_recovery_failed"));
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.toStatus, "stamped");
  assert.equal(lifecycle[0]?.reason, "rail:rail_primary:recovered");
  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "done");
  assert.equal((await casesFor(id)).length, 0);
});

test("cell 12 — reconcile skips an invoice whose outbox row is live but PARKED: no second row is queued", async () => {
  const id = await seedInvoice(12);
  const until = new Date(Date.now() + 60_000);
  const [parked] = await getDb()
    .insert(outboxTable)
    .values({
      aggregateType: "invoice",
      aggregateId: id,
      type: "invoice.submit",
      payload: { invoiceId: id },
      status: "pending",
      nextAttemptAt: until,
      parkedUntil: until,
      parkCount: 1,
      lastError: `RAIL_UNAVAILABLE: parked until ${until.toISOString()}`,
    })
    .returning({ id: outboxTable.id });
  const fake = scriptedRail({ name: FAKE });
  setRailTransport(fake);
  await reconcile();

  const rows = await getDb().select().from(outboxTable).where(eq(outboxTable.aggregateId, id));
  assert.equal(rows.length, 1, "the parked row is on its way; nothing was re-queued beside it");
  assert.equal(rows[0]?.id, parked!.id);
  assert.equal(rows[0]?.status, "pending");
  assert.equal(rows[0]?.parkedUntil?.getTime(), until.getTime(), "the park is untouched");
  assert.equal(await invoiceStatus(id), "submitted");
  assert.deepEqual(callsFor(fake, 12), [], "reconcile did not ask the rail about a submission already in flight");

  // Wake the park and let it stamp so the shared outbox carries no live row.
  await rewind(parked!.id);
  await drainUntilSettled(id);
  assert.equal(await invoiceStatus(id), "stamped");
});
