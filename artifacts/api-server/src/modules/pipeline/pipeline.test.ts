import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  getDb,
  firmsTable,
  partiesTable,
  invoicesTable,
  invoiceLinesTable,
  outboxTable,
  stampRecordsTable,
  submissionAttemptsTable,
  auditEventsTable,
  railStatesTable,
  type Rail,
} from "@workspace/db";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { clearRailEnv } from "../../test-helpers/rail-env.ts";
import { setRailTransport, type StampResult } from "../rails/adapter.ts";
import { scriptedRail } from "../rails/transports/scripted.ts";
import { drain, reconcile } from "./pipeline.ts";

// Resubmission safety (R97). Pinned against a real Postgres:
//  - a submission the rail answers MBS_DUPLICATE is recovered: the stamp the
//    rail already holds is fetched and persisted, the invoice lands on
//    `stamped`, the attempt rows keep the rejection AND the lookup, the stamp
//    carries the transport's provider/environment, and the audit chain says
//    `invoice.stamp_recovered`;
//  - a duplicate no rail can produce keeps the terminal failure, with
//    `invoice.stamp_recovery_failed` on the chain;
//  - reconcile() consults the rail before re-queuing a stuck `submitted`
//    invoice: a held stamp is persisted in place (0 re-queued), an unknown
//    one is re-queued (1);
//  - every attempt row retains the canonical request that was sent.
//
// The rail is the scripted fake (R95): scripts and held stamps are keyed by
// invoice number, so a bound fake never answers for stuck rows other suites
// left in the scratch DB — those are simply accepted.

const SALT = makeRunSalt();
const firm = randomUUID();
const supplier = randomUUID();
const buyer = randomUUID();

const invoiceNumber = (n: number) => `INV-PIPE-${n}-${SALT}`;

/** A live-environment fake rail; every test scripts its own invoice on it. */
const fakeRail = () => scriptedRail({ name: "fake-rail", environment: "live" });

/**
 * The stamp the fake hands back on lookup when it holds an invoice, tagged so
 * a test can tell which lookup produced the persisted record.
 */
const heldStamp = (tag: string): Partial<StampResult> => ({
  irn: `IRN-${tag}`,
  csid: `csid-${tag}`,
  qrPayload: "qr",
  signedArtifactRef: "sig",
  raw: { lookedUp: true },
});

async function seedInvoice(n: number, status: "submitted" | "draft" = "submitted") {
  const id = randomUUID();
  await getDb().insert(invoicesTable).values({
    id,
    firmId: firm,
    supplierPartyId: supplier,
    buyerPartyId: buyer,
    invoiceNumber: invoiceNumber(n),
    issueDate: "2026-08-01",
    dueDate: "2026-08-31",
    status: status as never,
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
  });
  await getDb().insert(invoiceLinesTable).values({
    invoiceId: id,
    lineNo: 1,
    description: `Consulting ${SALT}`,
    quantity: "1.0000",
    unitPrice: "100000.00",
    vatRate: "0.0750",
    lineExtension: "100000.00",
    vatAmount: "7500.00",
  });
  return id;
}

async function enqueueSubmit(invoiceId: string) {
  await getDb().insert(outboxTable).values({
    aggregateType: "invoice",
    aggregateId: invoiceId,
    type: "invoice.submit",
    payload: { invoiceId },
  });
}

/**
 * Drain the shared outbox until this invoice's event has settled. The scratch
 * DB is shared with every other suite, so the event is not necessarily among
 * the first few ready rows; drain in passes and stop once it is no longer
 * pending/processing (or nothing is ready).
 */
async function drainUntilSettled(invoiceId: string) {
  for (let pass = 0; pass < 20; pass++) {
    const [row] = await getDb()
      .select({ status: outboxTable.status })
      .from(outboxTable)
      .where(eq(outboxTable.aggregateId, invoiceId));
    if (row && row.status !== "pending" && row.status !== "processing") return;
    if ((await drain(50)) === 0) return;
  }
}

const invoiceStatus = async (id: string) =>
  (await getDb().select({ status: invoicesTable.status }).from(invoicesTable).where(eq(invoicesTable.id, id)))[0]?.status;

const auditActions = async (id: string) =>
  (await getDb().select({ action: auditEventsTable.action }).from(auditEventsTable).where(eq(auditEventsTable.entityId, id))).map((r) => r.action);

async function closeBreakers(): Promise<void> {
  for (const rail of ["rail_primary", "rail_secondary"] as Rail[]) {
    await getDb()
      .update(railStatesTable)
      .set({ state: "closed", failureCount: 0, openedAt: null, retryAt: null })
      .where(eq(railStatesTable.rail, rail));
  }
}

// RAIL_* is cleared for the whole file: setRailTransport(null) must resolve
// to the simulator here, never to a developer shell's HTTP rail (R95).
let restoreRailEnv: () => void = () => {};

before(async () => {
  restoreRailEnv = clearRailEnv();
  await closeBreakers();
  await getDb().insert(firmsTable).values({ id: firm, name: `Pipeline Firm ${SALT}` });
  await getDb().insert(partiesTable).values([
    {
      id: supplier,
      type: "client_business",
      legalName: `Pipeline Supplier ${SALT}`,
      tin: `1111-${SALT}`,
      street: "1 Broad Street",
      city: "Lagos",
      countryCode: "NG",
    },
    {
      id: buyer,
      type: "buyer",
      legalName: `Pipeline Buyer ${SALT}`,
      tin: `2222-${SALT}`,
      street: "2 Marina",
      city: "Lagos",
      countryCode: "NG",
    },
  ]);
});

after(async () => {
  setRailTransport(null);
  restoreRailEnv();
  await closeBreakers();
});

test("MBS_DUPLICATE is recovered: the held stamp is persisted, provenance and audit recorded", async () => {
  const id = await seedInvoice(1);
  await enqueueSubmit(id);
  // The rail says "duplicate" on submit and, holding the invoice, hands the
  // stamp back on lookup.
  const rail = fakeRail();
  rail.script(invoiceNumber(1), { outcome: "duplicate" });
  rail.hold(invoiceNumber(1), heldStamp("recovered"));
  setRailTransport(rail);
  try {
    await drainUntilSettled(id);
  } finally {
    setRailTransport(null);
  }
  assert.equal(await invoiceStatus(id), "stamped");
  const [stamp] = await getDb().select().from(stampRecordsTable).where(eq(stampRecordsTable.invoiceId, id));
  assert.equal(stamp?.irn, "IRN-recovered");
  assert.equal(stamp?.provider, "fake-rail");
  assert.equal(stamp?.environment, "live");
  const attempts = await getDb()
    .select()
    .from(submissionAttemptsTable)
    .where(eq(submissionAttemptsTable.invoiceId, id))
    .orderBy(asc(submissionAttemptsTable.createdAt), asc(submissionAttemptsTable.status));
  assert.equal(attempts.length, 2, "the rejection and the lookup are both retained");
  const rejected = attempts.find((a) => a.status === "rejected");
  const recovered = attempts.find((a) => a.status === "accepted");
  assert.equal(rejected?.errorCode, "MBS_DUPLICATE");
  assert.equal((rejected?.requestPayload as { canonical?: unknown })?.canonical !== undefined, true, "the full request is retained");
  assert.equal((recovered?.responsePayload as { recovered?: boolean })?.recovered, true);
  const actions = await auditActions(id);
  assert.ok(actions.includes("invoice.stamp_recovered"), actions.join(","));
  assert.ok(!actions.includes("invoice.rejected"));
  const [event] = await getDb().select().from(outboxTable).where(eq(outboxTable.aggregateId, id));
  assert.equal(event?.status, "done");
});

test("a duplicate no rail can produce keeps the terminal failure and says so", async () => {
  const id = await seedInvoice(2);
  await enqueueSubmit(id);
  // "Duplicate" on submit, but no rail holds the stamp: every lookup misses.
  const rail = fakeRail();
  rail.script(invoiceNumber(2), { outcome: "duplicate" });
  setRailTransport(rail);
  try {
    await drainUntilSettled(id);
  } finally {
    setRailTransport(null);
  }
  assert.equal(await invoiceStatus(id), "failed");
  const stamps = await getDb().select().from(stampRecordsTable).where(eq(stampRecordsTable.invoiceId, id));
  assert.equal(stamps.length, 0);
  const actions = await auditActions(id);
  assert.ok(actions.includes("invoice.stamp_recovery_failed"), actions.join(","));
  assert.ok(actions.includes("invoice.rejected"));
  const [event] = await getDb().select().from(outboxTable).where(eq(outboxTable.aggregateId, id));
  assert.equal(event?.status, "dead");
});

test("reconcile() persists a stamp the rail already holds instead of re-queuing", async () => {
  const id = await seedInvoice(3); // stuck: submitted, no stamp, no outbox row
  // reconcile() only asks (lookup); the rail holds this invoice's stamp.
  const rail = fakeRail();
  rail.hold(invoiceNumber(3), heldStamp("reconciled"));
  setRailTransport(rail);
  let requeued: number;
  try {
    requeued = await reconcile();
  } finally {
    setRailTransport(null);
  }
  assert.equal(await invoiceStatus(id), "stamped");
  const [stamp] = await getDb().select().from(stampRecordsTable).where(eq(stampRecordsTable.invoiceId, id));
  assert.equal(stamp?.irn, "IRN-reconciled");
  const live = await getDb()
    .select()
    .from(outboxTable)
    .where(and(eq(outboxTable.aggregateId, id), eq(outboxTable.status, "pending")));
  assert.equal(live.length, 0, "no resubmission was queued");
  const actions = await auditActions(id);
  assert.ok(actions.includes("invoice.stamp_recovered"), actions.join(","));
  // This run's own stuck invoice was recovered, not re-queued (other rows in
  // the shared scratch DB may be re-queued by the same pass).
  assert.equal(typeof requeued, "number");
});

test("reconcile() re-queues a stuck invoice the simulator does not remember", async () => {
  const id = await seedInvoice(4);
  setRailTransport(null);
  await reconcile();
  assert.equal(await invoiceStatus(id), "submitted");
  const rows = await getDb().select().from(outboxTable).where(eq(outboxTable.aggregateId, id));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.type, "invoice.submit");
});

test("an accepted submission retains the canonical request and names its provenance", async () => {
  const id = await seedInvoice(5);
  await enqueueSubmit(id);
  setRailTransport(null);
  await drainUntilSettled(id);
  assert.equal(await invoiceStatus(id), "stamped");
  const [attempt] = await getDb().select().from(submissionAttemptsTable).where(eq(submissionAttemptsTable.invoiceId, id));
  const request = attempt?.requestPayload as { canonical?: { invoiceNumber?: string }; idempotencyKey?: string };
  assert.equal(request?.canonical?.invoiceNumber, `INV-PIPE-5-${SALT}`);
  assert.equal(request?.idempotencyKey, `${id}:INV-PIPE-5-${SALT}`);
  const [stamp] = await getDb().select().from(stampRecordsTable).where(eq(stampRecordsTable.invoiceId, id));
  assert.equal(stamp?.provider, "simulator");
  assert.equal(stamp?.environment, "sandbox");
});
