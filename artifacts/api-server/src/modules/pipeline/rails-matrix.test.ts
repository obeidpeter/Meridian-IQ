import { test, before, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import {
  auditEventsTable,
  firmsTable,
  getDb,
  invoiceLifecycleEventsTable,
  invoiceLinesTable,
  invoicesTable,
  operatorCasesTable,
  outboxTable,
  partiesTable,
  pool,
  railStatesTable,
  stampRecordsTable,
  submissionAttemptsTable,
  type Rail,
} from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import {
  breakerStatus,
  setRailTransport,
  type RailTransport,
} from "../rails/adapter.ts";
import {
  scriptedRail,
  type ScriptedRail,
} from "../rails/transports/scripted.ts";
import { computeStatusLight } from "../clerk/status-light.ts";
import { explainInvoiceFailure } from "../clerk/explain.ts";
import { firmPrincipal } from "../../test-helpers/principals.ts";
import { clearRailEnv } from "../../test-helpers/rail-env.ts";
import { drain, reconcile, resumeWorker, stopWorker } from "./pipeline.ts";

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
//   10    primary unavailable, then   "boom"              rolled back: the attempt row and the claim undone, the
//         the transport throws                            breaker count KEPT (R102); the retry stamps exactly once
//   11    duplicate (stamp held)      MBS_DUPLICATE       recovered: invoice.stamp_recovered
//   12    reconcile vs a parked row   —                   a live parked row is never re-queued
//   13    one served rail, breaker    —                   park: nothing sent, wake at retry-at, stamps once closed
//         open
//   14    malformed (stamp held) on   RAIL_PROTOCOL       retry; the re-send's 409 recovers the stamp the 2xx hid
//         one served rail, then 409
//   15    unavailable, then reject    MBS_INVALID_TIN     failed; the rows of the try order by seq so the route,
//                                                          the status light and Clerk's explain all name the rejection
//   16    rate_limit + Retry-After    RAIL_RATE_LIMITED   retry with the rail's Retry-After as a FLOOR under the backoff
//   17    duplicate, lookups fail     RAIL_UNAVAILABLE    retry ("stamp lookup failed"), never a terminal failure;
//                                                          the replayed backoff recovers the stamp
//   18    reconcile, two stuck rows   —                   one transaction per invoice; a lookup error re-queues
//                                                          rather than aborting the pass
//   19    stopWorker() mid-drain      —                   the pass finishes the event in flight and claims no more
//                                                          (runs LAST: it leaves the worker's stop flag set)
//
// RAIL_* is cleared for the whole file so an unbound transport is the
// simulator, never a developer shell's HTTP rail.

const SALT = makeRunSalt();
const firm = randomUUID();
const supplier = randomUUID();
const buyer = randomUUID();
const RAILS: Rail[] = ["rail_primary", "rail_secondary"];
const FAKE = "matrix-rail";

type Cell = number | string;

const invoiceNumber = (n: Cell) => `INV-MATRIX-${n}-${SALT}`;

/** A `submitted` invoice; `createdAt` places it in reconcile's oldest-first batch. */
async function seedInvoice(n: Cell, opts: { createdAt?: Date } = {}) {
  const id = randomUUID();
  await getDb()
    .insert(invoicesTable)
    .values({
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
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
  await getDb()
    .insert(invoiceLinesTable)
    .values({
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
      .select({
        status: outboxTable.status,
        nextAttemptAt: outboxTable.nextAttemptAt,
      })
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
  (
    await getDb()
      .select({ status: invoicesTable.status })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, id))
  )[0]?.status;

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

// The rows in the order they were written (R95): rows of one try share
// attempt_no and created_at, and seq — the order the rails were called, the
// terminal answer last — is the tiebreak every reader relies on.
const attemptRowsBySeq = async (id: string) =>
  getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, id))
    .orderBy(asc(submissionAttemptsTable.seq));

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
  getDb()
    .select()
    .from(operatorCasesTable)
    .where(eq(operatorCasesTable.invoiceId, id));

const stampFor = async (id: string) =>
  (
    await getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, id))
  )[0];

/** The fake's call log for one invoice (other suites' stuck rows drain through it too). */
const callsFor = (fake: ScriptedRail, n: Cell) =>
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
async function settleRetry(
  fake: ScriptedRail,
  invoiceId: string,
  outboxId: string,
) {
  fake.reset();
  await rewind(outboxId);
  await drainUntilSettled(invoiceId);
  assert.equal(
    await invoiceStatus(invoiceId),
    "stamped",
    "the replayed backoff stamps",
  );
  assert.equal((await outboxRow(invoiceId)).status, "done");
}

async function setBreaker(
  rail: Rail,
  patch: {
    state: "closed" | "open";
    failureCount: number;
    openedAt: Date | null;
    retryAt: Date | null;
  },
) {
  await getDb()
    .insert(railStatesTable)
    .values({ rail })
    .onConflictDoNothing({ target: railStatesTable.rail });
  await getDb()
    .update(railStatesTable)
    .set(patch)
    .where(eq(railStatesTable.rail, rail));
}

async function closeBreakers(): Promise<void> {
  for (const rail of RAILS) {
    await setBreaker(rail, {
      state: "closed",
      failureCount: 0,
      openedAt: null,
      retryAt: null,
    });
  }
}

/**
 * Empty the shared ready queue under the bound transport, so the next claim
 * is this cell's own row (cells 18 and 19 count claims and re-queues).
 */
async function flushReadyQueue() {
  for (let pass = 0; pass < 20; pass++) {
    if ((await drain(50)) === 0) return;
  }
}

/** One retriable outcome on both rails: the shared shape of cells 2, 4, 5 and 6. */
async function runRetryCell(
  n: number,
  outcome: "rate_limit" | "timeout" | "unauthorized" | "malformed",
  code: string,
) {
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
  assert.ok(
    row.nextAttemptAt.getTime() > Date.now(),
    "backed off into the future",
  );
  assert.ok(
    row.firstAttemptAt && row.firstAttemptAt.getTime() >= before - 1_000,
    "the horizon clock started",
  );
  assert.equal(row.parkCount, 0, "a rail answer is not a park");
  assert.equal(row.lastError, code);
  assert.equal(
    await invoiceStatus(id),
    "submitted",
    "the invoice is NOT failed",
  );
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
  for (const rail of RAILS) {
    const breaker = await breakerStatus(rail);
    assert.equal(
      breaker.state,
      "closed",
      `${rail} is still under the threshold`,
    );
    assert.equal(breaker.failureCount, 1, `${rail} counted the ${outcome}`);
  }
  return { id, outboxId, fake };
}

let restoreRailEnv: () => void = () => {};

before(async () => {
  restoreRailEnv = clearRailEnv();
  await closeBreakers();
  await getDb()
    .insert(firmsTable)
    .values({ id: firm, name: `Matrix Firm ${SALT}` });
  await getDb()
    .insert(partiesTable)
    .values([
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
  restoreRailEnv();
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
  assert.equal(
    lifecycle[0]?.reason,
    "MBS_INVALID_TIN",
    "the rejection code is the transition reason",
  );
  assert.equal(lifecycle[0]?.actorRole, "system");
  const actions = await auditActions(id);
  assert.equal(
    actions.filter((a) => a === "invoice.rejected").length,
    1,
    actions.join(","),
  );
  assert.deepEqual(attemptShape(await attemptRows(id)), [
    ["rail_primary", "rejected", "MBS_INVALID_TIN", 1],
  ]);
  assert.deepEqual(
    callsFor(fake, 1),
    [{ op: "submit", rail: "rail_primary", outcome: "reject" }],
    "a rejection never fails over",
  );

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
  assert.ok(
    cases[0]?.title.includes("failed: MBS_INVALID_TIN"),
    cases[0]?.title,
  );
  assert.ok(cases[0]?.title.startsWith(invoiceNumber(1)), cases[0]?.title);
});

test("cell 2 — rate_limit on both rails: retry with backoff, invoice stays submitted, two RAIL_RATE_LIMITED attempts on one try", async () => {
  const { id, outboxId, fake } = await runRetryCell(
    2,
    "rate_limit",
    "RAIL_RATE_LIMITED",
  );
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
  assert.equal(
    stamp?.rail,
    "rail_secondary",
    "the failover rail issued the stamp",
  );
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
  assert.equal(
    primary.failureCount,
    1,
    "one transient failure counted against rail_primary",
  );
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
  const { id, outboxId, fake } = await runRetryCell(
    4,
    "timeout",
    "RAIL_TIMEOUT",
  );
  await settleRetry(fake, id, outboxId);
});

test("cell 5 — unauthorized: retry with RAIL_UNAUTHORIZED, the invoice is NOT failed", async () => {
  const { id, outboxId, fake } = await runRetryCell(
    5,
    "unauthorized",
    "RAIL_UNAUTHORIZED",
  );
  await settleRetry(fake, id, outboxId);
});

test("cell 6 — malformed answer: retry with RAIL_PROTOCOL", async () => {
  const { id, outboxId, fake } = await runRetryCell(
    6,
    "malformed",
    "RAIL_PROTOCOL",
  );
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
      if (inv.invoiceNumber !== invoiceNumber(7))
        return inner.submit(rail, inv, key);
      calls.push(rail);
      return {
        status: "error",
        rail,
        errorCode: "MBS_SCHEMA_INVALID",
        raw: {},
      };
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(transport);
  await drainUntilSettled(id);

  assert.deepEqual(
    calls,
    ["rail_primary"],
    "a non-retriable error does not fail over",
  );
  assert.equal(await invoiceStatus(id), "failed");
  assert.equal(await stampFor(id), undefined);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.fromStatus, "submitted");
  assert.equal(lifecycle[0]?.toStatus, "failed");
  assert.equal(lifecycle[0]?.reason, "MBS_SCHEMA_INVALID");
  const actions = await auditActions(id);
  assert.ok(
    !actions.includes("invoice.rejected"),
    `no business rejection was audited: ${actions.join(",")}`,
  );
  assert.deepEqual(attemptShape(await attemptRows(id)), [
    ["rail_primary", "error", "MBS_SCHEMA_INVALID", 1],
  ]);

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
  assert.deepEqual(callsFor(fake, 8), [
    { op: "submit", rail: "rail_secondary", outcome: "accept" },
  ]);
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
  assert.equal(
    row.parkCount,
    0,
    "one open breaker is not a full outage, so no park",
  );
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
  assert.deepEqual(attemptShape(await attemptRows(id)), [
    ["rail_primary", "error", "RAIL_UNAVAILABLE", 1],
    ["rail_secondary", "error", "RAIL_UNAVAILABLE", 1],
  ]);

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
  assert.deepEqual(attemptShape(attempts)[2], [
    "rail_primary",
    "accepted",
    null,
    2,
  ]);
  assert.deepEqual(
    callsFor(fake, 9).map((c) => `${c.rail}:${c.outcome}`),
    [
      "rail_primary:unavailable",
      "rail_secondary:unavailable",
      "rail_primary:accept",
    ],
  );
  assert.equal(
    (await breakerStatus("rail_primary")).failureCount,
    0,
    "the success reset rail_primary",
  );
  assert.equal(
    (await breakerStatus("rail_secondary")).failureCount,
    1,
    "rail_secondary still carries its one failure",
  );
  assert.equal((await lifecycleRows(id)).length, 1);
});

test("cell 10 — rail_primary unavailable, then the transport throws on rail_secondary: the try is rolled back (attempt, lifecycle and audit rows undone; the breaker count survives), retried with backoff, then stamped exactly once", async () => {
  const id = await seedInvoice(10);
  const outboxId = await enqueueSubmit(id);
  // rail_primary answers a real 503 through the inner fake — which makes the
  // adapter WRITE the breaker count before the throw — and rail_secondary's
  // submit throws. Everything the try wrote must go with the claim.
  const inner = scriptedRail({ name: "flaky-rail" });
  inner.script(invoiceNumber(10), { outcome: "unavailable", times: 1 });
  let thrown = false;
  const flaky: RailTransport = {
    name: "flaky-rail",
    environment: "sandbox",
    async submit(rail, inv, key) {
      if (
        !thrown &&
        rail === "rail_secondary" &&
        inv.invoiceNumber === invoiceNumber(10)
      ) {
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
  assert.equal(
    row.status,
    "pending",
    "the claim was rolled back and the row re-queued",
  );
  assert.equal(row.attempts, 1, "the failed try still counts");
  assert.equal(row.lastError, "boom");
  assert.ok(row.nextAttemptAt.getTime() > Date.now(), "backed off");
  assert.ok(row.firstAttemptAt, "the horizon clock started");
  assert.equal(row.parkCount, 0);
  assert.equal(await invoiceStatus(id), "submitted");
  assert.equal(
    (await attemptRows(id)).length,
    0,
    "no attempt row survives a rolled-back try — not even rail_primary's real 503",
  );
  assert.equal(
    (await lifecycleRows(id)).length,
    0,
    "no lifecycle row survives a rolled-back try",
  );
  assert.deepEqual(
    await auditActions(id),
    [],
    "no audit row survives a rolled-back try",
  );
  assert.equal(await stampFor(id), undefined);
  // R102: breaker writes commit on their own (raw pool), so the failure the
  // rail really produced is remembered even though the try rolled back.
  const primaryAfter = await breakerStatus("rail_primary");
  assert.equal(
    primaryAfter.failureCount,
    1,
    "rail_primary's failure survives the rolled-back try",
  );
  assert.equal(primaryAfter.lastErrorCode, "RAIL_UNAVAILABLE");
  assert.equal((await breakerStatus("rail_secondary")).failureCount, 0);
  assert.deepEqual(
    callsFor(inner, 10),
    [{ op: "submit", rail: "rail_primary", outcome: "unavailable" }],
    "the inner fake saw rail_primary's call; rail_secondary threw before reaching it",
  );

  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [["rail_primary", "accepted", null, 2]],
    "exactly one attempt row, the acceptance",
  );
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1, "exactly one lifecycle transition");
  assert.equal(lifecycle[0]?.fromStatus, "submitted");
  assert.equal(lifecycle[0]?.toStatus, "stamped");
  const actions = await auditActions(id);
  assert.deepEqual(
    actions,
    ["invoice.stamped"],
    "exactly one invoice.stamped, no duplicate rows",
  );
  assert.deepEqual(callsFor(inner, 10), [
    { op: "submit", rail: "rail_primary", outcome: "unavailable" },
    { op: "submit", rail: "rail_primary", outcome: "accept" },
  ]);
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
  assert.equal(
    stamp?.rail,
    "rail_primary",
    "the rail that reported the duplicate held the stamp",
  );
  assert.equal(stamp?.provider, FAKE);
  assert.match(
    stamp?.irn ?? "",
    /^IRN-[0-9A-F]{16}$/,
    "the fake mints a simulator-shaped stamp",
  );
  const attempts = await attemptRows(id);
  assert.deepEqual(attemptShape(attempts), [
    ["rail_primary", "accepted", null, 1],
    ["rail_primary", "rejected", "MBS_DUPLICATE", 1],
  ]);
  const lookup = attempts.find((a) => a.status === "accepted");
  assert.equal((lookup?.requestPayload as { lookup?: boolean })?.lookup, true);
  assert.equal(
    (lookup?.responsePayload as { recovered?: boolean })?.recovered,
    true,
  );
  const rejected = attempts.find((a) => a.status === "rejected");
  assert.ok(
    (rejected?.requestPayload as { canonical?: unknown })?.canonical,
    "the rejected try retains the request sent",
  );
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

  const rows = await getDb()
    .select()
    .from(outboxTable)
    .where(eq(outboxTable.aggregateId, id));
  assert.equal(
    rows.length,
    1,
    "the parked row is on its way; nothing was re-queued beside it",
  );
  assert.equal(rows[0]?.id, parked!.id);
  assert.equal(rows[0]?.status, "pending");
  assert.equal(
    rows[0]?.parkedUntil?.getTime(),
    until.getTime(),
    "the park is untouched",
  );
  assert.equal(await invoiceStatus(id), "submitted");
  assert.deepEqual(
    callsFor(fake, 12),
    [],
    "reconcile did not ask the rail about a submission already in flight",
  );

  // Wake the park and let it stamp so the shared outbox carries no live row.
  await rewind(parked!.id);
  await drainUntilSettled(id);
  assert.equal(await invoiceStatus(id), "stamped");
});

test("cell 13 — one served rail with its breaker open: the submission parks (nothing sent, no attempt burned, wake at retry-at) and stamps once the breaker closes", async () => {
  const id = await seedInvoice(13);
  const outboxId = await enqueueSubmit(id);
  const retryAt = new Date(Date.now() + 60_000);
  await setBreaker("rail_primary", {
    state: "open",
    failureCount: 3,
    openedAt: new Date(Date.now() - 10_000),
    retryAt,
  });
  // A deployment with one access point lit: rail_secondary is not served,
  // so the one refusal IS every breaker.
  const fake = scriptedRail({ name: FAKE, rails: ["rail_primary"] });
  setRailTransport(fake);
  await drainUntilSettled(id);

  let row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0, "a park burns no attempt");
  assert.equal(row.parkCount, 1);
  assert.equal(row.firstAttemptAt, null, "the horizon clock has not started");
  assert.ok(row.parkedUntil, "parked");
  assert.ok(
    row.parkedUntil!.getTime() >= retryAt.getTime(),
    "never before the breaker's retry-at",
  );
  assert.ok(
    row.parkedUntil!.getTime() <= retryAt.getTime() + 3_000,
    "jitter is bounded",
  );
  assert.equal(row.nextAttemptAt.getTime(), row.parkedUntil!.getTime());
  assert.match(row.lastError ?? "", /^RAIL_UNAVAILABLE: parked until /);
  assert.equal(
    (await attemptRows(id)).length,
    0,
    "a park is not a submission attempt",
  );
  assert.equal(await invoiceStatus(id), "submitted");
  assert.deepEqual(callsFor(fake, 13), [], "the rail was never called");
  assert.equal(
    (await breakerStatus("rail_secondary")).failureCount,
    0,
    "the unserved rail was never considered",
  );

  await setBreaker("rail_primary", {
    state: "closed",
    failureCount: 0,
    openedAt: null,
    retryAt: null,
  });
  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 1);
  assert.equal(row.parkCount, 1, "the park stays on the record");
  assert.equal(row.parkedUntil, null);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.equal((await stampFor(id))?.rail, "rail_primary");
  assert.deepEqual(callsFor(fake, 13), [
    { op: "submit", rail: "rail_primary", outcome: "accept" },
  ]);
});

test("cell 14 — malformed 2xx that actually stamped, on one served rail: retry with RAIL_PROTOCOL; the re-send's 409 recovers the stamp, rows in seq order", async () => {
  const id = await seedInvoice(14);
  const outboxId = await enqueueSubmit(id);
  // One access point lit, so the garbage answer is the whole try (with a
  // second rail served, the failover would consume the next script in the
  // same try). The rail DID stamp behind its unreadable 200, so the re-send
  // of the same idempotency key is a real 409 — scripted here as the fake
  // rail server would answer it.
  const fake = scriptedRail({ name: FAKE, rails: ["rail_primary"] });
  fake.script(invoiceNumber(14), {
    outcome: "malformed",
    holdsStamp: true,
    times: 1,
  });
  fake.script(invoiceNumber(14), {
    outcome: "duplicate",
    holdsStamp: true,
    times: 1,
  });
  setRailTransport(fake);
  await drainUntilSettled(id);

  let row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "pending", "a protocol error is retriable");
  assert.equal(row.attempts, 1);
  assert.equal(row.lastError, "RAIL_PROTOCOL");
  assert.ok(row.nextAttemptAt.getTime() > Date.now());
  assert.equal(
    await invoiceStatus(id),
    "submitted",
    "never failed on a 2xx we could not read",
  );
  assert.equal(await stampFor(id), undefined);
  assert.deepEqual(attemptShape(await attemptRows(id)), [
    ["rail_primary", "error", "RAIL_PROTOCOL", 1],
  ]);
  assert.equal((await breakerStatus("rail_primary")).failureCount, 1);
  assert.deepEqual(await auditActions(id), []);

  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await invoiceStatus(id), "stamped");
  const stamp = await stampFor(id);
  assert.equal(stamp?.rail, "rail_primary");
  assert.equal(stamp?.provider, FAKE);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.toStatus, "stamped");
  assert.equal(lifecycle[0]?.reason, "rail:rail_primary:recovered");
  const actions = await auditActions(id);
  assert.ok(actions.includes("invoice.stamp_recovered"), actions.join(","));
  assert.ok(
    !actions.includes("invoice.stamped"),
    "recovered, not freshly stamped",
  );
  assert.ok(!actions.includes("invoice.rejected"));
  assert.deepEqual(
    attemptShape(await attemptRowsBySeq(id)),
    [
      ["rail_primary", "error", "RAIL_PROTOCOL", 1],
      ["rail_primary", "rejected", "MBS_DUPLICATE", 2],
      ["rail_primary", "accepted", null, 2],
    ],
    "seq orders the rows: the retry's 409, then the lookup that recovered the stamp",
  );
  assert.deepEqual(callsFor(fake, 14), [
    { op: "submit", rail: "rail_primary", outcome: "malformed" },
    { op: "submit", rail: "rail_primary", outcome: "duplicate" },
    { op: "lookup", rail: "rail_primary", outcome: "lookup_hit" },
  ]);
  assert.equal(
    (await breakerStatus("rail_primary")).failureCount,
    0,
    "the answered retry reset the breaker",
  );
  assert.equal((await casesFor(id)).length, 0);
});

test("cell 15 — unavailable on rail_primary then MBS_INVALID_TIN on rail_secondary: failed, and the route order, the status light and Clerk's explain all name the rejection, not the 503", async () => {
  const id = await seedInvoice(15);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  fake.script(invoiceNumber(15), { outcome: "unavailable", times: 1 });
  fake.script(invoiceNumber(15), {
    outcome: "reject",
    code: "MBS_INVALID_TIN",
    times: 1,
  });
  setRailTransport(fake);
  await drainUntilSettled(id);

  assert.equal(await invoiceStatus(id), "failed");
  assert.equal(await stampFor(id), undefined);
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.toStatus, "failed");
  assert.equal(
    lifecycle[0]?.reason,
    "MBS_INVALID_TIN",
    "the rejection is the reason, not the failed-over 503",
  );
  const actions = await auditActions(id);
  assert.equal(
    actions.filter((a) => a === "invoice.rejected").length,
    1,
    actions.join(","),
  );
  const row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "dead");
  assert.equal(row.lastError, "MBS_INVALID_TIN");
  const cases = await casesFor(id);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.errorCode, "MBS_INVALID_TIN");
  assert.deepEqual(
    callsFor(fake, 15).map((c) => `${c.rail}:${c.outcome}`),
    ["rail_primary:unavailable", "rail_secondary:reject"],
  );
  assert.equal((await breakerStatus("rail_primary")).failureCount, 1);
  assert.equal(
    (await breakerStatus("rail_secondary")).failureCount,
    0,
    "a rejection is an answer",
  );

  // The two rows of the one try: same attempt_no, same created_at (they
  // committed together), seq strictly increasing in call order.
  const bySeq = await attemptRowsBySeq(id);
  assert.deepEqual(attemptShape(bySeq), [
    ["rail_primary", "error", "RAIL_UNAVAILABLE", 1],
    ["rail_secondary", "rejected", "MBS_INVALID_TIN", 1],
  ]);
  assert.ok(bySeq[0]!.seq != null && bySeq[1]!.seq != null);
  assert.ok(bySeq[1]!.seq > bySeq[0]!.seq, "seq is strictly increasing");
  assert.equal(
    bySeq[0]!.createdAt.getTime(),
    bySeq[1]!.createdAt.getTime(),
    "created_at cannot tell them apart",
  );

  // GET /invoices/:id/attempts — the same query documents.ts runs.
  const routeOrder = await getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, id))
    .orderBy(
      asc(submissionAttemptsTable.attemptNo),
      asc(submissionAttemptsTable.seq),
    );
  assert.equal(
    routeOrder.at(-1)?.status,
    "rejected",
    "the route lists the terminal answer last",
  );
  assert.equal(routeOrder.at(-1)?.errorCode, "MBS_INVALID_TIN");

  // The status light reads the rows unordered (the route selects without an
  // ORDER BY); hand them over rejection-first so only seq can pick the
  // latest.
  const light = computeStatusLight({
    invoice: { status: "failed", dueDate: "2026-08-31" },
    attempts: [...bySeq].reverse(),
    confirmations: [],
    stamp: null,
  });
  assert.equal(light.light, "red");
  assert.ok(
    light.reasons[0]?.includes("MBS_INVALID_TIN"),
    light.reasons.join(" | "),
  );

  // Clerk's explain (no provider → the grounded catalogue text) names the
  // latest row with a code — by seq, so the rejection and not the 503.
  const explained = await explainInvoiceFailure(id, firmPrincipal(firm), null);
  assert.equal(explained.errorCode, "MBS_INVALID_TIN");
  assert.equal(explained.source, "catalogue");
});

test("cell 16 — rate_limit with Retry-After: the rail's floor holds the retry back when it exceeds the backoff and is invisible when it does not", async () => {
  const slow = await seedInvoice("16a");
  const slowOutbox = await enqueueSubmit(slow);
  const quick = await seedInvoice("16b");
  const quickOutbox = await enqueueSubmit(quick);
  const fake = scriptedRail({ name: FAKE });
  // times: 2 covers both rails of the one try (scripts queue per invoice).
  fake.script(invoiceNumber("16a"), {
    outcome: "rate_limit",
    retryAfterSeconds: 30,
    times: 2,
  });
  fake.script(invoiceNumber("16b"), {
    outcome: "rate_limit",
    retryAfterSeconds: 1,
    times: 2,
  });
  setRailTransport(fake);
  const before = Date.now();
  await drainUntilSettled(slow);
  await drainUntilSettled(quick);

  const slowRow = await outboxRow(slow);
  assert.equal(slowRow.id, slowOutbox);
  assert.equal(slowRow.status, "pending");
  assert.equal(slowRow.attempts, 1);
  assert.equal(slowRow.lastError, "RAIL_RATE_LIMITED");
  assert.ok(
    slowRow.nextAttemptAt.getTime() >= before + 29_000,
    `a 30 s Retry-After floors the 2-4 s backoff: ${slowRow.nextAttemptAt.getTime() - before}ms`,
  );
  assert.ok(
    slowRow.nextAttemptAt.getTime() <= Date.now() + 31_000,
    "and is honoured as given, not inflated",
  );
  assert.deepEqual(attemptShape(await attemptRows(slow)), [
    ["rail_primary", "error", "RAIL_RATE_LIMITED", 1],
    ["rail_secondary", "error", "RAIL_RATE_LIMITED", 1],
  ]);
  assert.equal(await invoiceStatus(slow), "submitted");

  const quickRow = await outboxRow(quick);
  assert.equal(quickRow.id, quickOutbox);
  assert.equal(quickRow.status, "pending");
  assert.equal(quickRow.lastError, "RAIL_RATE_LIMITED");
  assert.ok(
    quickRow.nextAttemptAt.getTime() < Date.now() + 10_000,
    `a 1 s Retry-After leaves the normal backoff in charge: ${quickRow.nextAttemptAt.getTime() - Date.now()}ms`,
  );
  assert.ok(quickRow.nextAttemptAt.getTime() > Date.now(), "still backed off");

  await settleRetry(fake, slow, slowOutbox);
  await settleRetry(fake, quick, quickOutbox);
});

test("cell 17 — duplicate, then every lookup fails: retry saying the stamp lookup failed (never a terminal failure); the replayed backoff recovers the stamp", async () => {
  const id = await seedInvoice(17);
  const outboxId = await enqueueSubmit(id);
  const fake = scriptedRail({ name: FAKE });
  // The rail holds the stamp and answers 409 to every re-send of the key
  // (unbounded, as a real rail would); the first try's two lookups — the
  // reporting rail, then the other — cannot be answered.
  fake.script(invoiceNumber(17), { outcome: "duplicate", holdsStamp: true });
  fake.script(invoiceNumber(17), {
    op: "lookup",
    outcome: "unavailable",
    times: 2,
  });
  setRailTransport(fake);
  await drainUntilSettled(id);

  let row = await outboxRow(id);
  assert.equal(row.id, outboxId);
  assert.equal(row.status, "pending", "an unanswered lookup is a retry");
  assert.equal(row.attempts, 1);
  assert.match(row.lastError ?? "", /^RAIL_UNAVAILABLE: stamp lookup failed/);
  assert.ok(row.nextAttemptAt.getTime() > Date.now());
  assert.equal(
    await invoiceStatus(id),
    "submitted",
    "the invoice is NOT failed: the stamp may well exist",
  );
  assert.equal(await stampFor(id), undefined);
  assert.deepEqual(
    attemptShape(await attemptRows(id)),
    [["rail_primary", "rejected", "MBS_DUPLICATE", 1]],
    "exactly one attempt row: the 409 stays on the record",
  );
  const actions = await auditActions(id);
  assert.ok(
    !actions.includes("invoice.stamp_recovery_failed"),
    `no recovery-failed audit: ${actions.join(",")}`,
  );
  assert.ok(!actions.includes("invoice.rejected"));
  assert.equal((await lifecycleRows(id)).length, 0);
  assert.equal((await casesFor(id)).length, 0, "no Desk case for a retry");
  for (const rail of RAILS) {
    assert.equal(
      (await breakerStatus(rail)).failureCount,
      1,
      `${rail} counted its unanswered lookup`,
    );
  }
  assert.deepEqual(callsFor(fake, 17), [
    { op: "submit", rail: "rail_primary", outcome: "duplicate" },
    { op: "lookup", rail: "rail_primary", outcome: "unavailable" },
    { op: "lookup", rail: "rail_secondary", outcome: "unavailable" },
  ]);

  await rewind(outboxId);
  await drainUntilSettled(id);

  row = await outboxRow(id);
  assert.equal(row.status, "done");
  assert.equal(row.attempts, 2);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.equal((await stampFor(id))?.rail, "rail_primary");
  const lifecycle = await lifecycleRows(id);
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0]?.reason, "rail:rail_primary:recovered");
  assert.ok((await auditActions(id)).includes("invoice.stamp_recovered"));
  assert.deepEqual(attemptShape(await attemptRowsBySeq(id)), [
    ["rail_primary", "rejected", "MBS_DUPLICATE", 1],
    ["rail_primary", "rejected", "MBS_DUPLICATE", 2],
    ["rail_primary", "accepted", null, 2],
  ]);
  assert.deepEqual(callsFor(fake, 17).slice(3), [
    { op: "submit", rail: "rail_primary", outcome: "duplicate" },
    { op: "lookup", rail: "rail_primary", outcome: "lookup_hit" },
  ]);
  assert.equal(
    (await breakerStatus("rail_primary")).failureCount,
    0,
    "the answered lookup reset rail_primary",
  );
  assert.equal((await breakerStatus("rail_secondary")).failureCount, 1);
});

test("cell 18 — reconcile takes each stuck invoice in its own transaction: two unknown submissions are both re-queued, and a lookup error re-queues rather than aborting the pass", async () => {
  const fake = scriptedRail({ name: FAKE });
  setRailTransport(fake);
  // Settle whatever else the shared scratch DB holds first, so this pass's
  // count is these invoices alone; a created_at in 2000 puts them at the
  // head of reconcile's oldest-first batch whatever else is stuck.
  await reconcile();
  await flushReadyQueue();
  const a = await seedInvoice("18a", {
    createdAt: new Date("2000-01-01T00:00:00Z"),
  });
  const b = await seedInvoice("18b", {
    createdAt: new Date("2000-01-01T00:00:01Z"),
  });

  assert.equal(await reconcile(), 2, "both unknown submissions re-queued");
  for (const [n, id] of [
    ["18a", a],
    ["18b", b],
  ] as const) {
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.aggregateId, id));
    assert.equal(rows.length, 1, `${n}: exactly one row`);
    assert.equal(rows[0]?.status, "pending");
    assert.equal(rows[0]?.type, "invoice.submit");
    assert.equal(await invoiceStatus(id), "submitted");
    assert.deepEqual(
      callsFor(fake, n),
      [
        { op: "lookup", rail: "rail_primary", outcome: "lookup_miss" },
        { op: "lookup", rail: "rail_secondary", outcome: "lookup_miss" },
      ],
      `${n}: both rails were asked before the re-send`,
    );
  }
  await drainUntilSettled(a);
  await drainUntilSettled(b);
  assert.equal(await invoiceStatus(a), "stamped");
  assert.equal(await invoiceStatus(b), "stamped");

  // Neither rail can answer a lookup for the next two: each invoice's
  // failure is its own — the pass still reaches the second one.
  const c = await seedInvoice("18c", {
    createdAt: new Date("2000-01-01T00:00:02Z"),
  });
  const d = await seedInvoice("18d", {
    createdAt: new Date("2000-01-01T00:00:03Z"),
  });
  fake.script(invoiceNumber("18c"), { op: "lookup", outcome: "unavailable" });
  fake.script(invoiceNumber("18d"), { op: "lookup", outcome: "unavailable" });
  assert.equal(
    await reconcile(),
    2,
    "a lookup error re-queues; the pass is not aborted",
  );
  for (const [n, id] of [
    ["18c", c],
    ["18d", d],
  ] as const) {
    const rows = await getDb()
      .select()
      .from(outboxTable)
      .where(eq(outboxTable.aggregateId, id));
    assert.equal(rows.length, 1, `${n}: exactly one row`);
    assert.equal(rows[0]?.status, "pending");
    assert.equal(await invoiceStatus(id), "submitted");
    assert.deepEqual(
      callsFor(fake, n),
      [
        { op: "lookup", rail: "rail_primary", outcome: "unavailable" },
        { op: "lookup", rail: "rail_secondary", outcome: "unavailable" },
      ],
      `${n}: the fake saw both lookups`,
    );
  }
  for (const rail of RAILS) {
    assert.equal(
      (await breakerStatus(rail)).failureCount,
      2,
      `${rail} counted one unanswered lookup per invoice`,
    );
  }
  await drainUntilSettled(c);
  await drainUntilSettled(d);
  assert.equal(await invoiceStatus(c), "stamped");
  assert.equal(await invoiceStatus(d), "stamped");
});

test("cell 21 — R102: an event transaction holds no rail_states lock during its rail call, so another worker's breaker write never waits", async () => {
  await flushReadyQueue();
  const inner = scriptedRail({ name: "lock-free" });
  inner.script(invoiceNumber(21), { outcome: "unavailable", times: 1 });
  let observedMs: number | null = null;
  let observedError: string | null = null;
  const probing: RailTransport = {
    name: "lock-free",
    environment: "sandbox",
    async submit(rail, inv, key) {
      if (
        rail === "rail_secondary" &&
        inv.invoiceNumber === invoiceNumber(21)
      ) {
        // Mid-event, after rail_primary's failure was recorded: a second
        // worker writes the same breaker row on its own connection. Before
        // R102 that UPDATE queued behind this event's transaction until the
        // rail call ended — here it must complete at once.
        const client = await pool.connect();
        try {
          await client.query("SET statement_timeout = 2000");
          const started = Date.now();
          await client.query(
            "UPDATE rail_states SET updated_at = now() WHERE rail = 'rail_primary'",
          );
          observedMs = Date.now() - started;
        } catch (err) {
          observedError = err instanceof Error ? err.message : String(err);
        } finally {
          client.release();
        }
      }
      return inner.submit(rail, inv, key);
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(probing);
  const id = await seedInvoice(21);
  await enqueueSubmit(id);
  await drainUntilSettled(id);
  assert.equal(await invoiceStatus(id), "stamped");
  assert.equal(
    observedError,
    null,
    "the other worker's breaker write was not refused",
  );
  assert.ok(
    observedMs !== null && observedMs < 1_000,
    `the other worker's breaker write completed without waiting (${observedMs} ms)`,
  );
  const primary = await breakerStatus("rail_primary");
  assert.equal(primary.failureCount, 1);
  assert.equal(primary.lastErrorCode, "RAIL_UNAVAILABLE");
  assert.equal((await breakerStatus("rail_secondary")).failureCount, 0);
});

// stopWorker() leaves the worker's stop flag set; resumeWorker() clears it
// without arming any timer, so the cell restores a draining worker for
// whatever runs after it.
test("cell 19 — stopWorker() mid-drain: the pass finishes the event in flight and claims no more", async () => {
  const inner = scriptedRail({ name: "stopping-rail" });
  const stopping: RailTransport = {
    name: "stopping-rail",
    environment: "sandbox",
    async submit(rail, inv, key) {
      // The shutdown lands while this submission is on the wire.
      if (inv.invoiceNumber === invoiceNumber("19a")) stopWorker();
      return inner.submit(rail, inv, key);
    },
    async lookup(rail, inv, key) {
      return inner.lookup(rail, inv, key);
    },
  };
  setRailTransport(stopping);
  await flushReadyQueue();
  const a = await seedInvoice("19a");
  const outA = await enqueueSubmit(a);
  const b = await seedInvoice("19b");
  const outB = await enqueueSubmit(b);

  assert.equal(
    await drain(10),
    1,
    "the event in flight finished; nothing more was claimed",
  );
  assert.equal((await outboxRow(a)).status, "done");
  assert.equal(await invoiceStatus(a), "stamped");
  const rowB = await outboxRow(b);
  assert.equal(rowB.id, outB);
  assert.equal(rowB.status, "pending", "the second row was never claimed");
  assert.equal(rowB.attempts, 0);
  assert.equal(rowB.lockedAt, null);
  assert.equal(await invoiceStatus(b), "submitted");
  assert.deepEqual(callsFor(inner, "19b"), []);
  assert.equal(
    await drain(10),
    0,
    "still stopped: a further pass claims nothing",
  );

  resumeWorker();
  await drainUntilSettled(b);
  assert.equal((await outboxRow(a)).id, outA);
  assert.equal((await outboxRow(b)).status, "done");
  assert.equal(await invoiceStatus(b), "stamped");
});
