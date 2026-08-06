import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  engagementsTable,
  filingReturnsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { DomainError } from "../errors.ts";
import {
  narrowToClientPartyScope,
  type Principal,
} from "../auth/rbac.ts";
import {
  countOpenFilings,
  listFilings,
  loadFilingForScope,
  mintFilingsForFirm,
  updateFilingStatus,
} from "./filings.ts";
import { sweepFilingMint } from "./sweep.ts";
import {
  filingDueDate,
  previousLagosPeriod,
  type FilingTaxType,
} from "./statutory-calendar.ts";
import { lagosDateOffset, makeRunSalt } from "../../test-helpers/fixtures.ts";

// The filings register module: calendar-driven minting (live engagements
// only, natural-key idempotent, sweep = sync), the forward-only status walk
// with its evidence rules and audit trail, the SEC-03 loader/narrowing, list
// filters/order, and the single fact function's FILTER math. Fixtures are
// salted and every assertion is scoped to this run's own firm ids — the
// shared DB persists across runs and sibling suites (and the sweep mints for
// EVERY firm in it, so nothing here counts globally).

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
// A dedicated firm the SWEEP (not a direct mint) must discover and fill.
const sweepFirmId = randomUUID();
// A dedicated firm for the count math so its FILTER counts stay exact.
const countFirmId = randomUUID();
const clientA = randomUUID();
const clientB = randomUUID();
// Engaged once, archived — the live-engagement wall must exclude it.
const clientArchived = randomUUID();
const sweepClient = randomUUID();
const countClient = randomUUID();
const userId = randomUUID();

// Frozen clock: a mid-August instant, so the minted period and both due
// dates are exact (and agree with the pure calendar functions).
const FROZEN_NOW = new Date("2026-08-06T12:00:00Z");
const PERIOD = previousLagosPeriod(FROZEN_NOW); // 2026-07

const firmStaff: Principal = {
  userId,
  role: "firm_admin",
  firmId,
  clientPartyId: null,
  buyerPartyId: null,
};
const foreignStaff: Principal = { ...firmStaff, firmId: otherFirmId };
const clientUserB: Principal = {
  userId,
  role: "client_user",
  firmId,
  clientPartyId: clientB,
  buyerPartyId: null,
};

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `filing-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Filing Firm ${SALT}` },
    { id: otherFirmId, name: `Filing Firm B ${SALT}` },
    { id: sweepFirmId, name: `Filing Sweep Firm ${SALT}` },
    { id: countFirmId, name: `Filing Count Firm ${SALT}` },
  ]);
  await db.insert(partiesTable).values(
    [clientA, clientB, clientArchived, sweepClient, countClient].map(
      (id, i) => ({
        id,
        type: "client_business" as const,
        legalName: `Filing Client ${i} ${SALT}`,
      }),
    ),
  );
  await db.insert(engagementsTable).values([
    // clientA holds TWO live engagements — selectDistinct must not double-mint.
    {
      firmId,
      clientPartyId: clientA,
      type: "retainer" as const,
      status: "open" as const,
      title: `filing A1 ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientA,
      type: "vat_risk_check" as const,
      status: "in_progress" as const,
      title: `filing A2 ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientB,
      type: "retainer" as const,
      status: "in_progress" as const,
      title: `filing B ${SALT}`,
    },
    {
      firmId,
      clientPartyId: clientArchived,
      type: "retainer" as const,
      status: "archived" as const,
      title: `filing archived ${SALT}`,
    },
    {
      firmId: sweepFirmId,
      clientPartyId: sweepClient,
      type: "retainer" as const,
      status: "open" as const,
      title: `filing sweep ${SALT}`,
    },
  ]);
});

async function rowsFor(firm: string) {
  return getDb()
    .select()
    .from(filingReturnsTable)
    .where(eq(filingReturnsTable.firmId, firm));
}

test("mintFilingsForFirm: live clients × kinds, correct dates, idempotent, archived excluded", async () => {
  const minted = await mintFilingsForFirm(firmId, FROZEN_NOW);
  assert.equal(minted, 4, "2 live clients × 2 kinds (clientA counted once)");

  const rows = await rowsFor(firmId);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.period, "2026-07", "the last closed Lagos month");
    assert.equal(row.status, "upcoming");
    assert.equal(
      row.dueDate,
      row.taxType === "vat" ? "2026-08-21" : "2026-08-10",
    );
  }
  for (const client of [clientA, clientB]) {
    // The UNCONDITIONAL kinds only: neither client holds a WHT-categorised
    // bill this period, so no wht row mints for them (the conditional-mint
    // test below covers a withholding client).
    assert.deepEqual(
      rows
        .filter((r) => r.clientPartyId === client)
        .map((r) => r.taxType)
        .sort(),
      ["paye", "vat"],
    );
  }
  assert.ok(
    rows.every((r) => r.clientPartyId !== clientArchived),
    "an archived-only client mints nothing",
  );

  // Second mint: the natural key already holds every row.
  assert.equal(await mintFilingsForFirm(firmId, FROZEN_NOW), 0);
});

test("sweepFilingMint: discovers live-engagement firms, mints nothing new for a current one", async () => {
  const result = await sweepFilingMint(FROZEN_NOW);
  // The shared DB holds other suites' firms too — assert only this run's.
  assert.ok(result.firms >= 2, "both fixture firms enumerated");
  assert.equal((await rowsFor(firmId)).length, 4, "sweep after mint = 0 new");

  const sweepRows = await rowsFor(sweepFirmId);
  assert.equal(sweepRows.length, 2, "the sweep filled the undiscovered firm");
  for (const row of sweepRows) {
    assert.equal(row.clientPartyId, sweepClient);
    assert.equal(row.period, PERIOD);
    assert.equal(
      row.dueDate,
      filingDueDate(PERIOD, row.taxType as FilingTaxType),
    );
  }

  // A second pass is a no-op for this run's firms.
  await sweepFilingMint(FROZEN_NOW);
  assert.equal((await rowsFor(firmId)).length, 4);
  assert.equal((await rowsFor(sweepFirmId)).length, 2);
});

test("listFilings: due-date order, filters, paging, foreign firm sees nothing", async () => {
  const all = await listFilings(firmId);
  assert.deepEqual(
    all.map((r) => r.dueDate),
    ["2026-08-10", "2026-08-10", "2026-08-21", "2026-08-21"],
    "soonest due first (PAYE's 10th ahead of VAT's 21st), id tiebreak",
  );

  const vatOnly = await listFilings(firmId, { taxType: "vat" });
  assert.equal(vatOnly.length, 2);
  assert.ok(vatOnly.every((r) => r.taxType === "vat"));

  const forA = await listFilings(firmId, { clientPartyId: clientA });
  assert.equal(forA.length, 2);
  assert.ok(forA.every((r) => r.clientPartyId === clientA));

  assert.equal((await listFilings(firmId, { status: "upcoming" })).length, 4);
  assert.equal((await listFilings(firmId, { status: "filed" })).length, 0);

  const page = await listFilings(firmId, { limit: 1, offset: 1 });
  assert.deepEqual(
    page.map((r) => r.id),
    [all[1].id],
  );

  // A foreign firm sees nothing of this firm's register.
  assert.equal((await listFilings(otherFirmId)).length, 0);
});

test("updateFilingStatus: the forward-only walk with evidence rules and audit", async () => {
  const [vatA] = await listFilings(firmId, {
    clientPartyId: clientA,
    taxType: "vat",
  });
  const [payeA] = await listFilings(firmId, {
    clientPartyId: clientA,
    taxType: "paye",
  });
  const [vatB] = await listFilings(firmId, {
    clientPartyId: clientB,
    taxType: "vat",
  });

  // upcoming → prepared: preparedBy recorded, no evidence yet.
  const prepared = await updateFilingStatus(
    vatA.id,
    firmId,
    { status: "prepared", notes: "workings attached" },
    userId,
  );
  assert.equal(prepared?.status, "prepared");
  assert.equal(prepared?.preparedBy, userId);
  assert.equal(prepared?.filedBy, null);
  assert.equal(prepared?.notes, "workings attached");

  // prepared → filed: evidence lands, filedBy recorded, notes kept when omitted.
  const filed = await updateFilingStatus(
    vatA.id,
    firmId,
    {
      status: "filed",
      filedDate: "2026-08-20",
      filedReference: `TPM-${SALT}`,
    },
    userId,
  );
  assert.equal(filed?.status, "filed");
  assert.equal(filed?.filedDate, "2026-08-20");
  assert.equal(filed?.filedReference, `TPM-${SALT}`);
  assert.equal(filed?.filedBy, userId);
  assert.equal(filed?.preparedBy, userId);
  assert.equal(filed?.notes, "workings attached");

  // upcoming → filed directly: legal; only filedBy is set.
  const direct = await updateFilingStatus(
    payeA.id,
    firmId,
    { status: "filed", filedDate: "2026-08-08" },
    userId,
  );
  assert.equal(direct?.status, "filed");
  assert.equal(direct?.filedBy, userId);
  assert.equal(direct?.preparedBy, null);
  assert.equal(direct?.filedReference, null);

  // Backward and same-status walks are conflicts.
  const badTransition = (err: unknown) =>
    err instanceof DomainError &&
    err.code === "FILING_BAD_TRANSITION" &&
    err.status === 409;
  await assert.rejects(
    updateFilingStatus(vatA.id, firmId, { status: "prepared" }, userId),
    badTransition,
    "filed cannot fall back to prepared",
  );
  await assert.rejects(
    updateFilingStatus(
      vatA.id,
      firmId,
      { status: "filed", filedDate: "2026-08-21" },
      userId,
    ),
    badTransition,
    "filed cannot re-file",
  );
  await updateFilingStatus(vatB.id, firmId, { status: "prepared" }, userId);
  await assert.rejects(
    updateFilingStatus(vatB.id, firmId, { status: "prepared" }, userId),
    badTransition,
    "same-status is not a walk",
  );

  // Filed REQUIRES a real filedDate.
  const badDate = (err: unknown) =>
    err instanceof DomainError &&
    err.code === "FILING_BAD_DATE" &&
    err.status === 400;
  await assert.rejects(
    updateFilingStatus(vatB.id, firmId, { status: "filed" }, userId),
    badDate,
    "filed without a date",
  );
  for (const bad of ["20/08/2026", "2026-8-2", "2026-02-30"]) {
    await assert.rejects(
      updateFilingStatus(
        vatB.id,
        firmId,
        { status: "filed", filedDate: bad },
        userId,
      ),
      badDate,
      `filedDate ${bad} must be rejected`,
    );
  }

  // Prepared REJECTS filing evidence.
  const badEvidence = (err: unknown) =>
    err instanceof DomainError &&
    err.code === "FILING_UNEXPECTED_EVIDENCE" &&
    err.status === 400;
  const [payeB] = await listFilings(firmId, {
    clientPartyId: clientB,
    taxType: "paye",
  });
  await assert.rejects(
    updateFilingStatus(
      payeB.id,
      firmId,
      { status: "prepared", filedDate: "2026-08-08" },
      userId,
    ),
    badEvidence,
  );
  await assert.rejects(
    updateFilingStatus(
      payeB.id,
      firmId,
      { status: "prepared", filedReference: "TPM-1" },
      userId,
    ),
    badEvidence,
  );
  assert.equal(
    (await listFilings(firmId, { clientPartyId: clientB, taxType: "paye" }))[0]
      .status,
    "upcoming",
    "a rejected walk changes nothing",
  );

  // A foreign firm's id updates zero rows — the route's 404 path.
  assert.equal(
    await updateFilingStatus(
      payeB.id,
      otherFirmId,
      { status: "prepared" },
      userId,
    ),
    null,
  );

  // Audit: one pointer-only status event per legal transition on vatA.
  const events = await getDb()
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.entityType, "filing_return"),
        eq(auditEventsTable.entityId, vatA.id),
      ),
    );
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.action === "filing.status"));
  const preparedEvent = events.find(
    (e) => (e.after as { status: string }).status === "prepared",
  );
  assert.deepEqual(preparedEvent?.before, { status: "upcoming" });
  assert.deepEqual(preparedEvent?.after, {
    status: "prepared",
    taxType: "vat",
    period: "2026-07",
  });
});

test("SEC-03: the loader's 404 non-disclosure and the list narrowing", async () => {
  const [rowA] = await listFilings(firmId, { clientPartyId: clientA });

  // Own firm staff load fine.
  assert.equal((await loadFilingForScope(rowA.id, firmStaff)).id, rowA.id);

  const notFound = (err: unknown) =>
    err instanceof DomainError && err.code === "NOT_FOUND" && err.status === 404;
  // Missing id, foreign tenant and sibling client are indistinguishable.
  await assert.rejects(loadFilingForScope(randomUUID(), firmStaff), notFound);
  await assert.rejects(loadFilingForScope(rowA.id, foreignStaff), notFound);
  await assert.rejects(loadFilingForScope(rowA.id, clientUserB), notFound);

  // Own row loads for the client_user.
  const [rowB] = await listFilings(firmId, { clientPartyId: clientB });
  assert.equal((await loadFilingForScope(rowB.id, clientUserB)).id, rowB.id);

  // The route's list composition: a client_user is pinned to its own party
  // with no filter, and a sibling filter is rejected outright.
  const pinned = narrowToClientPartyScope(clientUserB, undefined);
  assert.equal(pinned, clientB);
  const narrowed = await listFilings(firmId, { clientPartyId: pinned });
  assert.ok(narrowed.length > 0);
  assert.ok(narrowed.every((r) => r.clientPartyId === clientB));
  assert.throws(
    () => narrowToClientPartyScope(clientUserB, clientA),
    (err: unknown) =>
      err instanceof DomainError && err.code === "CROSS_CLIENT",
  );
});

test("countOpenFilings: one SQL pass over the Lagos calendar", async () => {
  // Seeded around lagos-today with absolute due dates (distinct periods to
  // dodge the natural key): yesterday is overdue; today and the window edge
  // are due-soon; past the edge is unfiled-but-quiet; a filed row is off
  // every clock.
  const seed = (
    period: string,
    dueDate: string,
    status: "upcoming" | "prepared" | "filed",
  ) => ({
    firmId: countFirmId,
    clientPartyId: countClient,
    taxType: "vat",
    period,
    dueDate,
    status,
  });
  await getDb()
    .insert(filingReturnsTable)
    .values([
      seed("2098-01", lagosDateOffset(-1), "upcoming"),
      seed("2098-02", lagosDateOffset(0), "upcoming"),
      seed("2098-03", lagosDateOffset(7), "prepared"),
      seed("2098-04", lagosDateOffset(8), "upcoming"),
      seed("2098-05", lagosDateOffset(-30), "filed"),
    ]);

  const counts = await countOpenFilings(countFirmId);
  assert.equal(counts.unfiled, 4, "prepared still counts as unfiled");
  assert.equal(counts.dueSoon, 2, "today and today+window are both due-soon");
  assert.equal(counts.overdue, 1, "overdue starts the day AFTER the due date");
  assert.equal(counts.nextDueDate, lagosDateOffset(-1));

  // The client pin: countClient owns everything here, clientA nothing.
  assert.deepEqual(await countOpenFilings(countFirmId, clientA), {
    unfiled: 0,
    dueSoon: 0,
    overdue: 0,
    nextDueDate: null,
  });
  assert.equal((await countOpenFilings(countFirmId, countClient)).unfiled, 4);

  // The injectable today: from far in the future every unfiled row is overdue.
  const future = await countOpenFilings(
    countFirmId,
    undefined,
    sql`'2200-01-01'::date`,
  );
  assert.equal(future.overdue, 4);
  assert.equal(future.dueSoon, 0);
});

test("wht rows mint ONLY for clients with withholding bills in the period", async () => {
  // A dedicated firm: one client that took a WHT-categorised bill inside the
  // period, one that did not (its only withholding bill is cancelled, plus
  // one outside the period). vat/paye stay unconditional for both.
  const whtFirmId = randomUUID();
  const whtClient = randomUUID();
  const plainClient = randomUUID();
  const whtVendor = randomUUID();
  const db = getDb();
  await db.insert(firmsTable).values({ id: whtFirmId, name: `Filing WHT Firm ${SALT}` });
  await db.insert(partiesTable).values([
    { id: whtClient, type: "client_business", legalName: `Filing WHT Client ${SALT}` },
    { id: plainClient, type: "client_business", legalName: `Filing Plain Client ${SALT}` },
    { id: whtVendor, type: "buyer", legalName: `Filing WHT Vendor ${SALT}` },
  ]);
  await db.insert(engagementsTable).values([
    {
      firmId: whtFirmId,
      clientPartyId: whtClient,
      type: "retainer" as const,
      status: "open" as const,
      title: `filing wht A ${SALT}`,
    },
    {
      firmId: whtFirmId,
      clientPartyId: plainClient,
      type: "retainer" as const,
      status: "open" as const,
      title: `filing wht B ${SALT}`,
    },
  ]);
  // Bills: supplier is the non-engaged vendor, buyer is the client (the
  // BILL_OF_CLIENT orientation). Only the first qualifies: in-period,
  // categorised, not cancelled.
  const bill = (
    buyer: string,
    invoiceNumber: string,
    issueDate: string,
    status: "draft" | "cancelled" = "draft",
  ) => ({
    firmId: whtFirmId,
    supplierPartyId: whtVendor,
    buyerPartyId: buyer,
    invoiceNumber,
    status,
    issueDate,
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
    whtCategory: "services_5",
  });
  await db.insert(invoicesTable).values([
    bill(whtClient, `FW-IN-${SALT}`, "2026-07-15"),
    bill(plainClient, `FW-CANCEL-${SALT}`, "2026-07-10", "cancelled"),
    bill(plainClient, `FW-OLD-${SALT}`, "2026-06-15"),
  ]);

  // 2 clients × (vat, paye) + ONE wht row for the withholding client.
  assert.equal(await mintFilingsForFirm(whtFirmId, FROZEN_NOW), 5);
  const rows = await rowsFor(whtFirmId);
  const whtRows = rows.filter((r) => r.taxType === "wht");
  assert.equal(whtRows.length, 1);
  assert.equal(whtRows[0].clientPartyId, whtClient);
  assert.equal(whtRows[0].period, "2026-07");
  assert.equal(whtRows[0].dueDate, "2026-08-21", "FIRS: remit by the 21st");
  assert.deepEqual(
    rows
      .filter((r) => r.clientPartyId === plainClient)
      .map((r) => r.taxType)
      .sort(),
    ["paye", "vat"],
    "a cancelled or out-of-period bill mints no wht row",
  );

  // Idempotent: the natural key already holds every row.
  assert.equal(await mintFilingsForFirm(whtFirmId, FROZEN_NOW), 0);
});
