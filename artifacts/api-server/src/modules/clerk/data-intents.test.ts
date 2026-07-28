import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  claimRecordsTable,
  engagementsTable,
  firmsTable,
  partiesTable,
  invoicesTable,
  settlementEventsTable,
  usersTable,
  submissionAttemptsTable,
  type ProtectedFact,
} from "@workspace/db";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window.ts";
import { askClerk } from "./ask.ts";
import {
  CLIENT_SAFE_DATA_INTENTS,
  DATA_INTENTS,
  DATA_INTENT_PREFIX,
  RECEIVABLE_AGE_DAYS,
  getDataIntent,
  lagosMonthOptions,
  runDataIntent,
} from "./data-intents.ts";
import type { CompletionRequest } from "./gateway.ts";
import { inClerkScope } from "./scope.ts";
import {
  fakeGateway,
  restoreClerkFlag,
  saveAndEnableClerkFlag,
} from "./test-support.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Grounded firm-data Q&A (idea #6). The invariants pinned here:
//  - every lookup's numbers come from SQL over the asker's own firm — another
//  firm's rows never leak into a count or a sample;
//  - the lookups run under the real firm-scoped RLS posture (inClerkScope),
//  exactly as ask.ts runs them;
//  - the closed enum offers data keys ONLY to firm-scoped askers, and a model
//  that names one anyway without a firm scope produces a refusal, never data.

const SALT = makeRunSalt();

const firmA = randomUUID();
const firmB = randomUUID();
const partyA = randomUUID();
const partyA2 = randomUUID();
const partyB = randomUUID();
// Non-engaged vendor: the SUPPLIER on the captured bills below (bill
// orientation = buyer engaged, supplier not).
const vendorParty = randomUUID();
const askerId = randomUUID();
// Client-facing Ask (SEC-03): a client_user pinned to partyA2, and a second
// staff user for the cross-user multi-turn assertions.
const clientAskerId = randomUUID();
const secondStaffId = randomUUID();

// Exact Lagos calendar dates (WAT is fixed UTC+1, no DST), so the statutory
// window predicates are tested without day-boundary flakiness.
function lagosDateOffset(days: number): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const OVERDUE_NUM = `OVD-${SALT}`;
const BOUNDARY_NUM = `BND-${SALT}`;
const DUE_SOON_NUM = `DUE-${SALT}`;
const FAILED_NUM = `FLD-${SALT}`;
const ACCEPTED_NUM = `ACC-${SALT}`;
const ACCEPTED_OLD_NUM = `ACO-${SALT}`;
const CLIENT2_OVERDUE_NUM = `OV2-${SALT}`;
const RECEIVABLE_NUM = `REC-${SALT}`;
const FOREIGN_NUM = `FOREIGN-${SALT}`;
const BILL_DUE_NUM = `BILL-DUE-${SALT}`;
const BILL_OLD_NUM = `BILL-OLD-${SALT}`;
const BILL_PAID_NUM = `BILL-PAID-${SALT}`;

// Month options as ask.ts offers them: [0] = current, [2] = two months back.
const MONTHS = lagosMonthOptions();

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Data Intents Firm A ${SALT}` },
    { id: firmB, name: `Data Intents Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: partyA, type: "client_business", legalName: `DI Party A ${SALT}` },
    // "Z" so partyA always sorts first in the client-key list (c1), whatever
    // the database collation.
    { id: partyA2, type: "client_business", legalName: `DI Party Z ${SALT}` },
    { id: partyB, type: "client_business", legalName: `DI Party B ${SALT}` },
    { id: vendorParty, type: "buyer", legalName: `DI Vendor ${SALT}` },
  ]);
  // Engagements make both parties firm A's clients — the source of the
  // closed client-key list ask.ts offers the classifier — and, since the
  // payables round, the receivable orientation of the firm-wide counters
  // (firm B engages partyB for the same reason).
  await db.insert(engagementsTable).values([
    {
      firmId: firmA,
      clientPartyId: partyA,
      type: "readiness_assessment",
      title: `DI engagement A ${SALT}`,
    },
    {
      firmId: firmA,
      clientPartyId: partyA2,
      type: "readiness_assessment",
      title: `DI engagement Z ${SALT}`,
    },
    {
      firmId: firmB,
      clientPartyId: partyB,
      type: "readiness_assessment",
      title: `DI engagement B ${SALT}`,
    },
  ]);
  await db
    .insert(usersTable)
    .values([
      { id: askerId, email: `di-asker-${SALT}@test.example` },
      { id: clientAskerId, email: `di-client-${SALT}@test.example` },
      { id: secondStaffId, email: `di-staff2-${SALT}@test.example` },
    ])
    .onConflictDoNothing();

  type InvoiceSeed = typeof invoicesTable.$inferInsert;
  const invoice = (
    over: Partial<InvoiceSeed> &
      Pick<InvoiceSeed, "invoiceNumber" | "issueDate">,
  ): InvoiceSeed => ({
    firmId: firmA,
    supplierPartyId: partyA,
    buyerPartyId: partyA,
    ...over,
  });
  const acceptedId = randomUUID();
  const acceptedOldId = randomUUID();
  const billPaidId = randomUUID();
  await db.insert(invoicesTable).values([
    // Past the statutory window and still unsubmitted.
    invoice({
      invoiceNumber: OVERDUE_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-30),
    }),
    // Issued exactly SUBMISSION_WINDOW_DAYS days ago: the deadline was LAST
    // Lagos midnight, so today this is already overdue — the boundary day on
    // which the dashboards, reminders, digest and Ask Clerk must all agree.
    invoice({
      invoiceNumber: BOUNDARY_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-SUBMISSION_WINDOW_DAYS),
    }),
    // Deadline lands inside the next 7 days (issue -3 + window 7 = +4).
    invoice({
      invoiceNumber: DUE_SOON_NUM,
      status: "validated",
      issueDate: lagosDateOffset(-3),
    }),
    invoice({
      invoiceNumber: FAILED_NUM,
      status: "failed",
      issueDate: lagosDateOffset(-2),
    }),
    // Accepted by the rails this month (attempt row inserted below).
    invoice({
      id: acceptedId,
      invoiceNumber: ACCEPTED_NUM,
      status: "submitted",
      issueDate: lagosDateOffset(-1),
      grandTotal: "500.00",
    }),
    // Accepted by the rails two Lagos months ago (attempt row below carries
    // the explicit created_at) — the month-parameter target. Issue date kept
    // inside the receivable window so it never counts as aged.
    invoice({
      id: acceptedOldId,
      invoiceNumber: ACCEPTED_OLD_NUM,
      status: "submitted",
      issueDate: lagosDateOffset(-40),
      grandTotal: "750.00",
    }),
    // A second client's overdue draft — the client-parameter target.
    invoice({
      invoiceNumber: CLIENT2_OVERDUE_NUM,
      supplierPartyId: partyA2,
      status: "draft",
      issueDate: lagosDateOffset(-30),
    }),
    // Stamped long ago and unpaid — an aged receivable.
    invoice({
      invoiceNumber: RECEIVABLE_NUM,
      status: "stamped",
      issueDate: lagosDateOffset(-120),
      dueDate: lagosDateOffset(-(RECEIVABLE_AGE_DAYS + 30)),
      grandTotal: "1000.00",
    }),
    // Another firm's overdue invoice: must never appear in firm A's answers.
    {
      firmId: firmB,
      supplierPartyId: partyB,
      buyerPartyId: partyB,
      invoiceNumber: FOREIGN_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-30),
    },
    // Captured supplier BILLS (payables round): the engaged client is the
    // BUYER, the vendor the supplier. Draft forever. BILL_OLD's ancient
    // issue date is the counter-hygiene probe: without the receivable
    // orientation on the firm-wide branch it would read as a 4th "overdue
    // submission".
    {
      firmId: firmA,
      supplierPartyId: vendorParty,
      buyerPartyId: partyA,
      invoiceNumber: BILL_DUE_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-4),
      dueDate: lagosDateOffset(3),
      grandTotal: "200.00",
    },
    {
      id: billPaidId,
      firmId: firmA,
      supplierPartyId: vendorParty,
      buyerPartyId: partyA,
      invoiceNumber: BILL_PAID_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-4),
      dueDate: lagosDateOffset(2),
      grandTotal: "400.00",
    },
    {
      firmId: firmA,
      supplierPartyId: vendorParty,
      buyerPartyId: partyA2,
      invoiceNumber: BILL_OLD_NUM,
      status: "draft",
      issueDate: lagosDateOffset(-30),
      grandTotal: "300.00",
    },
  ]);
  // Payment evidence retires BILL_PAID from every unpaid-bill answer.
  await db.insert(settlementEventsTable).values({
    invoiceId: billPaidId,
    source: "payer_flag",
    amount: "400.00",
    paymentStatus: "paid",
    actorId: askerId,
    occurredAt: new Date(),
  });
  await db.insert(submissionAttemptsTable).values([
    {
      invoiceId: acceptedId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `di-${SALT}`,
      status: "accepted",
      // Anchored to the SAME month list the assertions use (mid-month, so
      // it is inside MONTHS[0] whatever today is) instead of insert-time
      // now() — otherwise a Lagos month rollover between module load and
      // this insert would break every this-month assertion.
      createdAt: new Date(`${MONTHS[0].key}-15T12:00:00Z`),
    },
    {
      invoiceId: acceptedOldId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `di-old-${SALT}`,
      status: "accepted",
      // Mid-month noon UTC (13:00 Lagos): unambiguously inside the month two
      // back, whatever today's date is.
      createdAt: new Date(`${MONTHS[2].key}-15T12:00:00Z`),
    },
  ]);
});

after(async () => {
  await restoreClerkFlag();
});

// Run a lookup exactly as ask.ts does: inside the asker's firm-scoped RLS.
const lookup = (key: string, firmId = firmA) =>
  inClerkScope(firmId, () => runDataIntent(key, firmId));

test("the catalogue is namespaced, unique and model-describable", () => {
  const keys = DATA_INTENTS.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, "keys must be unique");
  for (const intent of DATA_INTENTS) {
    assert.ok(intent.key.startsWith(DATA_INTENT_PREFIX));
    assert.ok(intent.title.trim().length > 0);
  }
  assert.equal(getDataIntent("data.nonexistent"), undefined);
});

test("overdue lookup counts only the asker's firm — never a sibling firm's rows", async () => {
  const result = await lookup("data.overdue_submissions");
  assert.ok(result);
  const count = result.facts.find((f) => f.key === "count");
  assert.equal(count?.value, "3");
  const sample = result.facts.find((f) => f.key === "sample");
  assert.ok(sample?.value.includes(OVERDUE_NUM));
  assert.ok(
    sample?.value.includes(BOUNDARY_NUM),
    "the deadline day itself is already overdue (same boundary as the dashboards)",
  );
  assert.ok(!sample?.value.includes(FOREIGN_NUM), "firm B must not leak");
  assert.ok(
    result.text.includes(
      `past the ${SUBMISSION_WINDOW_DAYS}-day submission window`,
    ),
  );
  assert.ok(result.text.includes(OVERDUE_NUM));
});

test("due-soon, failed and unsubmitted lookups mirror the dashboard predicates", async () => {
  const dueSoon = await lookup("data.due_soon_submissions");
  assert.equal(dueSoon?.facts.find((f) => f.key === "count")?.value, "1");
  assert.ok(dueSoon?.text.includes(DUE_SOON_NUM));
  assert.ok(
    !dueSoon?.text.includes(BOUNDARY_NUM),
    "a deadline that passed at last midnight is overdue, not due soon",
  );

  const failed = await lookup("data.failed_submissions");
  assert.equal(failed?.facts.find((f) => f.key === "count")?.value, "1");
  assert.ok(failed?.text.includes(FAILED_NUM));

  // Unsubmitted = the three overdue drafts + the due-soon validated invoice.
  const unsubmitted = await lookup("data.unsubmitted_invoices");
  assert.equal(unsubmitted?.facts.find((f) => f.key === "count")?.value, "4");
});

test("submitted-this-month and aged-receivables carry platform-computed totals", async () => {
  const accepted = await lookup("data.submitted_this_month");
  assert.equal(accepted?.facts.find((f) => f.key === "count")?.value, "1");
  const acceptedTotal = accepted?.facts.find((f) => f.key === "total_value");
  assert.equal(acceptedTotal?.value, "500.00");
  assert.equal(acceptedTotal?.unit, "NGN");
  assert.ok(accepted?.text.includes(ACCEPTED_NUM));

  const receivables = await lookup("data.aged_receivables");
  assert.equal(receivables?.facts.find((f) => f.key === "count")?.value, "1");
  assert.equal(
    receivables?.facts.find((f) => f.key === "total_value")?.value,
    "1000.00",
  );
  assert.ok(receivables?.text.includes(RECEIVABLE_NUM));
});

test("clerk-allowance lookup reports the budget without touching a provider", async () => {
  const result = await lookup("data.clerk_allowance");
  assert.ok(result);
  const used = Number(result.facts.find((f) => f.key === "used_tokens")?.value);
  const budget = Number(
    result.facts.find((f) => f.key === "budget_tokens")?.value,
  );
  const remaining = Number(
    result.facts.find((f) => f.key === "remaining_tokens")?.value,
  );
  assert.ok(budget > 0, "a firm always has a positive allowance");
  assert.equal(remaining, Math.max(0, budget - used));
});

test("askClerk answers a data question with platform-computed numbers", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    return JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
    });
  });
  const kase = await askClerk("What is overdue?", askerId, gateway, {
    firmId: firmA,
  });
  assert.equal(kase.status, "approved");
  assert.ok(kase.answer);
  assert.equal(kase.answer.answered, true);
  assert.equal(kase.answer.dataIntent, "data.overdue_submissions");
  assert.ok(
    kase.answer.proposition?.includes(OVERDUE_NUM),
    "the answer names the platform-found invoice",
  );
  assert.ok(kase.answer.facts && kase.answer.facts.length > 0);
  assert.ok(
    kase.answer.citation?.startsWith(
      "Computed live from your firm's records on ",
    ),
  );

  // The closed enum and the prompt offered the data keys to this firm-scoped
  // asker — and only keys the platform defined.
  assert.equal(calls.length, 1);
  const props = calls[0].jsonSchema.properties as {
    claimKey: { enum: string[] };
  };
  assert.ok(props.claimKey.enum.includes("data.overdue_submissions"));
  assert.ok(props.claimKey.enum.includes("none"));
  assert.ok(typeof calls[0].user === "string");
  assert.ok((calls[0].user as string).includes("Available data keys"));
});

test("without a firm scope, data keys are never offered and never answer", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    // The model tries to name a data key it was never offered.
    return JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
    });
  });
  const kase = await askClerk("What is overdue?", askerId, gateway);
  // Whether the register is empty (refused before any call) or not (the
  // closed-enum validator discards the fabricated key), the outcome is the
  // same: a refusal, never firm data.
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
  for (const call of calls) {
    const props = call.jsonSchema.properties as {
      claimKey: { enum: string[] };
    };
    assert.ok(
      props.claimKey.enum.every((k) => !k.startsWith(DATA_INTENT_PREFIX)),
      "no data key may be offered without a firm scope",
    );
  }
});

test("a data answer runs zero lookups for a foreign firm id", async () => {
  // Belt-and-braces check on the explicit firm filter: running firm B's
  // lookup returns firm B's row and nothing of firm A's.
  const result = await lookup("data.overdue_submissions", firmB);
  assert.equal(result?.facts.find((f) => f.key === "count")?.value, "1");
  assert.ok(result?.facts.find((f) => f.key === "sample")?.value.includes(FOREIGN_NUM));
  assert.ok(!result?.text.includes(OVERDUE_NUM));
});

// ---- Parameterized lookups (idea #4) ----------------------------------------

test("lagosMonthOptions builds a closed, app-owned list of the last 12 months", () => {
  const months = lagosMonthOptions(12, new Date("2026-01-15T12:00:00Z"));
  assert.equal(months.length, 12);
  assert.equal(months[0].key, "2026-01");
  assert.equal(months[0].label, "January 2026 (current month)");
  assert.equal(months[0].monthStart, "2026-01-01");
  // Year rollover: month two back from January is November of the prior year.
  assert.equal(months[1].key, "2025-12");
  assert.equal(months[2].key, "2025-11");
  assert.equal(months[2].label, "November 2025");
  for (const m of months) {
    assert.match(m.key, /^\d{4}-\d{2}$/);
    assert.equal(m.monthStart, `${m.key}-01`);
  }
});

test("a month parameter narrows submitted-this-month to that Lagos month", async () => {
  const target = MONTHS[2];
  const result = await inClerkScope(firmA, () =>
    runDataIntent("data.submitted_this_month", firmA, {
      monthStart: target.monthStart,
      monthLabel: target.label,
    }),
  );
  assert.equal(result?.facts.find((f) => f.key === "count")?.value, "1");
  assert.equal(
    result?.facts.find((f) => f.key === "total_value")?.value,
    "750.00",
  );
  assert.ok(result?.text.includes(ACCEPTED_OLD_NUM));
  assert.ok(
    !result?.text.includes(ACCEPTED_NUM),
    "this month's acceptance must not leak into a past month's answer",
  );
  assert.ok(result?.text.includes(`in ${target.label}`));
});

test("a client parameter narrows a lookup to that client's own invoices", async () => {
  const forClient2 = await inClerkScope(firmA, () =>
    runDataIntent("data.overdue_submissions", firmA, {
      clientPartyId: partyA2,
      clientName: `DI Party Z ${SALT}`,
    }),
  );
  assert.equal(forClient2?.facts.find((f) => f.key === "count")?.value, "1");
  assert.ok(forClient2?.text.includes(CLIENT2_OVERDUE_NUM));
  assert.ok(!forClient2?.text.includes(OVERDUE_NUM));
  assert.ok(forClient2?.text.includes(`for DI Party Z ${SALT}`));

  const forClient1 = await inClerkScope(firmA, () =>
    runDataIntent("data.overdue_submissions", firmA, {
      clientPartyId: partyA,
      clientName: `DI Party A ${SALT}`,
    }),
  );
  assert.equal(forClient1?.facts.find((f) => f.key === "count")?.value, "2");
  assert.ok(!forClient1?.text.includes(CLIENT2_OVERDUE_NUM));
});

test("askClerk resolves month and client keys through its own option lists", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    // c1 = the firm's first client by name (partyA — "DI Party A ..." sorts
    // before "DI Party Z ..."), month = the current Lagos month.
    return JSON.stringify({
      claimKey: "data.submitted_this_month",
      category: "unknown",
      month: MONTHS[0].key,
      client: "c1",
    });
  });
  const kase = await askClerk(
    "What did DI Party A submit this month?",
    askerId,
    gateway,
    { firmId: firmA },
  );
  assert.equal(kase.status, "approved");
  assert.equal(kase.answer?.answered, true);
  assert.equal(kase.answer?.dataIntent, "data.submitted_this_month");
  // The label the user sees names the resolved scope (current-month marker
  // stripped), and the answer counts only that client's acceptances.
  assert.deepEqual(kase.answer?.dataParams, {
    month: MONTHS[0].label.replace(" (current month)", ""),
    client: `DI Party A ${SALT}`,
  });
  assert.ok(kase.answer?.proposition?.includes(ACCEPTED_NUM));
  assert.ok(!kase.answer?.proposition?.includes(ACCEPTED_OLD_NUM));

  // The classifier was offered the closed option lists — and only those.
  assert.equal(calls.length, 1);
  const props = calls[0].jsonSchema.properties as {
    month: { enum: string[] };
    client: { enum: string[] };
  };
  assert.deepEqual(props.month.enum, [...MONTHS.map((m) => m.key), "none"]);
  assert.deepEqual(props.client.enum, ["c1", "c2", "none"]);
  assert.ok((calls[0].user as string).includes("Month keys"));
  assert.ok((calls[0].user as string).includes(`c1: DI Party A ${SALT}`));
});

test("a parameter the lookup cannot honour refuses — never a silently unfiltered answer", async () => {
  // Month on an as-of-today lookup.
  const monthGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: MONTHS[1].key,
    }),
  );
  const monthCase = await askClerk("Overdue in a past month?", askerId, monthGateway, {
    firmId: firmA,
  });
  assert.equal(monthCase.status, "escalated");
  assert.equal(monthCase.answer?.answered, false);
  assert.ok(
    monthCase.answer?.refusalReason?.includes("always answers as of today"),
  );

  // Client on the firm-wide allowance lookup.
  const clientGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.clerk_allowance",
      category: "unknown",
      client: "c1",
    }),
  );
  const clientCase = await askClerk(
    "How many Clerk tokens has DI Party A used?",
    askerId,
    clientGateway,
    { firmId: firmA },
  );
  assert.equal(clientCase.status, "escalated");
  assert.ok(
    clientCase.answer?.refusalReason?.includes("covers the whole firm"),
  );
});

test("a fabricated month or client key never validates — the case escalates", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.submitted_this_month",
      category: "unknown",
      month: "2019-03", // not in the offered list
      client: "none",
    }),
  );
  const kase = await askClerk("What about March 2019?", askerId, gateway, {
    firmId: firmA,
  });
  // The closed enum rejects the key at validation, so classification fails
  // and the question escalates — no lookup ever ran.
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
});

test("money intents: outstanding, expected inflows and chase list", async () => {
  // Outstanding = submitted/stamped/confirmed: ACC (500) + ACO (750) +
  // REC (1000), all owed by DI Party A.
  const outstanding = await lookup("data.outstanding_receivables");
  assert.ok(outstanding);
  assert.match(
    outstanding.text,
    /3 invoices are outstanding, NGN 2250\.00 in total/,
  );
  assert.ok(outstanding.text.includes(`DI Party A ${SALT}`), "names debtors");
  assert.equal(outstanding.facts.find((f) => f.key === "count")?.value, "3");
  assert.equal(
    outstanding.facts.find((f) => f.key === "total_value")?.value,
    "2250.00",
  );

  // No behaviour is mined here, so projections run on due date / terms: the
  // two old outstanding invoices are past expectation, nothing lands in the
  // coming week.
  const inflows = await lookup("data.expected_inflows");
  assert.ok(inflows);
  assert.match(
    inflows.text,
    /No payments are expected across your clients in the coming week/,
  );
  assert.match(inflows.text, /2 invoices are already past the expected/);
  assert.equal(
    inflows.facts.find((f) => f.key === "past_expected")?.value,
    "2",
  );

  // Chase-worthy = past expectation AND past due (or no due date): both old
  // invoices qualify; the aged receivable (90d beyond) ranks first.
  const chase = await lookup("data.chase_list");
  assert.ok(chase);
  assert.match(chase.text, /2 invoices across your clients are worth chasing/);
  assert.ok(chase.text.includes(RECEIVABLE_NUM));
  assert.match(chase.text, /90d beyond expectation/);

  // Client scoping: DI Party Z has only a draft — nothing outstanding.
  const scoped = await inClerkScope(firmA, () =>
    runDataIntent("data.outstanding_receivables", firmA, {
      clientPartyId: partyA2,
      clientName: `DI Party Z ${SALT}`,
    }),
  );
  assert.ok(scoped);
  assert.match(scoped.text, new RegExp(`Nothing is outstanding for DI Party Z ${SALT}`));

  // Firm isolation: firm B's only invoice is a draft — and firm A's rows
  // must never bleed into its answer.
  const foreign = await lookup("data.outstanding_receivables", firmB);
  assert.ok(foreign);
  assert.match(foreign.text, /Nothing is outstanding/);
});

test("payables intents: bills due and total owed are buyer-side, client-pinnable and linkless", async () => {
  // Firm-wide bills due within 7 days: only BILL_DUE (BILL_OLD has no due
  // date; BILL_PAID carries payment evidence).
  const due = await lookup("data.payables_due");
  assert.ok(due);
  assert.equal(due.facts.find((f) => f.key === "count")?.value, "1");
  assert.equal(due.facts.find((f) => f.key === "total_value")?.value, "200.00");
  assert.ok(due.text.includes(BILL_DUE_NUM));
  assert.ok(!due.text.includes(BILL_PAID_NUM), "paid bills never answer");
  assert.equal(due.links, undefined, "bill answers carry NO links (SEC-03)");

  // Total owed: every unpaid bill whatever the due date.
  const owed = await lookup("data.total_owed");
  assert.ok(owed);
  assert.equal(owed.facts.find((f) => f.key === "count")?.value, "2");
  assert.equal(owed.facts.find((f) => f.key === "total_value")?.value, "500.00");
  assert.ok(owed.text.includes(BILL_OLD_NUM));
  assert.equal(owed.links, undefined);

  // The client pin lands on the BUYER column: partyA2 owes only BILL_OLD.
  const pinned = await inClerkScope(firmA, () =>
    runDataIntent("data.total_owed", firmA, {
      clientPartyId: partyA2,
      clientName: `DI Party Z ${SALT}`,
    }),
  );
  assert.equal(pinned?.facts.find((f) => f.key === "count")?.value, "1");
  assert.ok(pinned?.text.includes(BILL_OLD_NUM));
  assert.ok(!pinned?.text.includes(BILL_DUE_NUM));
  assert.ok(pinned?.text.includes(`for DI Party Z ${SALT}`));

  // Firm isolation: firm B has no bills.
  const foreign = await lookup("data.total_owed", firmB);
  assert.equal(foreign?.facts.find((f) => f.key === "count")?.value, "0");

  // Counter hygiene closes the loop: the ancient draft BILL_OLD must NOT
  // read as an overdue submission (the firm-wide branch is receivable-
  // oriented) — the earlier overdue test's count of 3 already pins this;
  // here the sample is checked by name.
  const overdue = await lookup("data.overdue_submissions");
  assert.ok(!overdue?.facts.find((f) => f.key === "sample")?.value.includes(BILL_OLD_NUM));
});

test("data.vat_position phrases platform-computed totals — client-pinnable, month-aware and linkless", async () => {
  const intent = getDataIntent("data.vat_position");
  assert.ok(intent, "the catalogue carries the VAT position intent");
  assert.deepEqual(intent.accepts, { month: true, client: true });
  assert.ok(
    CLIENT_SAFE_DATA_INTENTS.some((i) => i.key === "data.vat_position"),
    "client-safe: the forced own-party pin reduces it to the caller's own documents",
  );

  // Firm-wide: the rollup totals, one row per engaged client (firm A engages
  // exactly two parties here), defaulting to the current Lagos month.
  const firmWide = await lookup("data.vat_position");
  assert.ok(firmWide);
  assert.match(firmWide.text, /VAT position across 2 engaged clients in /);
  assert.match(firmWide.text, /defensible net \(verified input only\)/);
  assert.equal(
    firmWide.links,
    undefined,
    "VAT position answers carry NO links (the input side is bills — SEC-03)",
  );
  for (const key of [
    "output_vat",
    "input_vat",
    "input_vat_verified",
    "net_vat",
    "defensible_net_vat",
  ]) {
    // Explicitly typed: the assert.ok(firmWide) narrowing above plus the
    // loop back-edge otherwise trips TS7022 on the inferred type.
    const fact: ProtectedFact | undefined = firmWide.facts.find(
      (f) => f.key === key,
    );
    assert.equal(fact?.kind, "amount", `${key} fact present as an amount`);
    assert.equal(fact?.unit, "NGN");
  }

  // The client pin + an explicit month key resolve exactly like the other
  // parameterized lookups.
  const pinned = await inClerkScope(firmA, () =>
    runDataIntent("data.vat_position", firmA, {
      clientPartyId: partyA2,
      clientName: `DI Party Z ${SALT}`,
      monthStart: MONTHS[0].monthStart,
      monthLabel: MONTHS[0].label,
    }),
  );
  assert.ok(pinned);
  assert.ok(pinned.text.includes(`for DI Party Z ${SALT}`));
  assert.ok(pinned.text.includes(`in ${MONTHS[0].label}`));
  assert.equal(pinned.links, undefined);
  assert.equal(pinned.facts.find((f) => f.key === "net_vat")?.unit, "NGN");
});

test("multi-turn: a previous data answer threads follow-up context by keys only", async () => {
  // First turn: a client-scoped overdue lookup, classified normally.
  const firstGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: "none",
      client: "c1", // partyA — sorts first in the offered list
    }),
  );
  const first = await askClerk(
    `What is overdue for DI Party A? ${SALT}`,
    askerId,
    firstGateway,
    { firmId: firmA },
  );
  assert.equal(first.answer?.dataIntent, "data.overdue_submissions");

  // Follow-up: the classifier sees the previous intent + parameter KEYS —
  // never a raw party id or name — and can carry the client over.
  const prompts: string[] = [];
  const followGateway = fakeGateway((req) => {
    prompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.unsubmitted_invoices",
      category: "unknown",
      month: "none",
      client: "c1",
    });
  });
  const followUp = await askClerk(
    `And what is still unsubmitted? ${SALT}`,
    askerId,
    followGateway,
    { firmId: firmA, previousCaseId: first.id },
  );
  assert.equal(followUp.answer?.dataIntent, "data.unsubmitted_invoices");
  assert.ok(
    prompts[0].includes("Previous question context"),
    "context line present",
  );
  assert.ok(
    prompts[0].includes("data.overdue_submissions"),
    "previous intent named",
  );
  assert.ok(prompts[0].includes("client c1"), "client carried as an opaque key");
  assert.ok(
    !prompts[0].includes(partyA),
    "raw party ids never reach the prompt",
  );

  // A foreign firm's case id contributes NO context (firm filter), and a
  // fabricated id contributes none either.
  const cleanPrompts: string[] = [];
  const cleanGateway = fakeGateway((req) => {
    cleanPrompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: "none",
      client: "none",
    });
  });
  await askClerk(`Overdue again? ${SALT}`, askerId, cleanGateway, {
    firmId: firmB,
    previousCaseId: first.id, // firm A's case — must be invisible to firm B
  });
  assert.ok(
    !cleanPrompts[0].includes("Previous question context"),
    "cross-firm context never leaks",
  );
});

test("multi-turn: a current-month scope survives the label round-trip", async () => {
  // The stored dataParams strip " (current month)" from the label; the
  // follow-up mapping must strip the offered labels the same way, or the
  // single most common follow-up ("…and for Acme?" after a this-month
  // question) silently loses its month (round-12 review, finding 1).
  const currentMonthKey = lagosMonthOptions()[0].key;
  const firstGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.submitted_this_month",
      category: "unknown",
      month: currentMonthKey,
      client: "none",
    }),
  );
  const first = await askClerk(
    `What did we submit this month? ${SALT}`,
    askerId,
    firstGateway,
    { firmId: firmA },
  );
  assert.equal(first.answer?.dataIntent, "data.submitted_this_month");
  assert.ok(first.answer?.dataParams?.month, "month label stored");

  const prompts: string[] = [];
  const followGateway = fakeGateway((req) => {
    prompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.submitted_this_month",
      category: "unknown",
      month: currentMonthKey,
      client: "c1",
    });
  });
  await askClerk(`And for DI Party A? ${SALT}`, askerId, followGateway, {
    firmId: firmA,
    previousCaseId: first.id,
  });
  assert.ok(
    prompts[0].includes(`month ${currentMonthKey}`),
    `current-month key carried into the context (prompt: ${prompts[0].slice(0, 400)})`,
  );
});

// ---- Client-facing Ask (SEC-03 subset) --------------------------------------

test("the client-safe subset is an allowlist that excludes every firm-wide intent", () => {
  const safeKeys = CLIENT_SAFE_DATA_INTENTS.map((i) => i.key);
  for (const excluded of [
    "data.outstanding_receivables",
    "data.expected_inflows",
    "data.chase_list",
    "data.clerk_allowance",
  ]) {
    assert.ok(
      !safeKeys.includes(excluded),
      `${excluded} embeds firm-wide content and must never be offered to a client`,
    );
  }
  // Everything offered accepts a client filter — the forced own-party pin in
  // ask.ts must be honourable by every intent a client can name.
  for (const intent of CLIENT_SAFE_DATA_INTENTS) {
    assert.equal(
      intent.accepts.client,
      true,
      `${intent.key} must accept a client filter to be client-safe`,
    );
  }
});

test("client-scoped Ask offers only the caller's own party and pins the lookup to it", async () => {
  const calls: CompletionRequest[] = [];
  const gateway = fakeGateway((req) => {
    calls.push(req);
    // The model deliberately picks NO client — the app must still pin the
    // lookup to the caller's own party (the scope comes from the principal).
    return JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: "none",
      client: "none",
    });
  });
  const kase = await askClerk(`What is overdue? ${SALT}`, clientAskerId, gateway, {
    firmId: firmA,
    clientScoped: true,
    clientPartyId: partyA2,
  });
  assert.equal(kase.status, "approved");
  assert.equal(kase.answer?.answered, true);
  assert.equal(kase.answer?.dataIntent, "data.overdue_submissions");
  // The answer names ONLY the caller's own party — the forced scope.
  assert.deepEqual(kase.answer?.dataParams, { client: `DI Party Z ${SALT}` });
  assert.ok(
    kase.answer?.proposition?.includes(CLIENT2_OVERDUE_NUM),
    "the caller's own overdue invoice is named",
  );
  assert.ok(
    !kase.answer?.proposition?.includes(OVERDUE_NUM),
    "a sibling client's invoices must never appear (SEC-03)",
  );

  // The closed enums offered to the classifier: exactly one client option
  // (the caller), and no excluded intent key anywhere.
  assert.equal(calls.length, 1);
  const props = calls[0].jsonSchema.properties as {
    claimKey: { enum: string[] };
    client: { enum: string[] };
  };
  assert.deepEqual(
    props.client.enum,
    ["c1", "none"],
    "the client option list is EXACTLY the caller's own party",
  );
  assert.ok(props.claimKey.enum.includes("data.overdue_submissions"));
  for (const excluded of [
    "data.outstanding_receivables",
    "data.expected_inflows",
    "data.chase_list",
    "data.clerk_allowance",
  ]) {
    assert.ok(
      !props.claimKey.enum.includes(excluded),
      `${excluded} must not be offered to a client asker`,
    );
  }
  const prompt = calls[0].user as string;
  assert.ok(prompt.includes(`c1: DI Party Z ${SALT}`));
  assert.ok(
    !prompt.includes(`DI Party A ${SALT}`),
    "sibling client names must never reach a client asker's prompt",
  );
});

test("an intent excluded from the client subset refuses — never a firm-wide answer", async () => {
  const gateway = fakeGateway(() =>
    // The model names a firm-wide intent the client enum never offered: the
    // closed validator discards it and the ordinary refusal machinery
    // answers.
    JSON.stringify({
      claimKey: "data.chase_list",
      category: "unknown",
      month: "none",
      client: "none",
    }),
  );
  const kase = await askClerk(
    `Who is worth chasing? ${SALT}`,
    clientAskerId,
    gateway,
    { firmId: firmA, clientScoped: true, clientPartyId: partyA2 },
  );
  assert.equal(kase.status, "escalated");
  assert.equal(kase.answer?.answered, false);
  assert.ok(kase.answer?.refusalReason, "a refusal, never firm-wide data");
});

test("multi-turn for a client threads only its OWN cases; firm staff keep firm-wide threading", async () => {
  // A data-answered case created by a STAFF user in the same firm.
  const staffGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: "none",
      client: "none",
    }),
  );
  const staffCase = await askClerk(
    `Staff overdue? ${SALT}`,
    askerId,
    staffGateway,
    { firmId: firmA },
  );
  assert.equal(staffCase.answer?.dataIntent, "data.overdue_submissions");

  // A client follow-up naming the staff case: same firm, but not the same
  // user — the firm filter alone is not a sibling wall (SEC-03), so the
  // context line must be absent.
  const clientPrompts: string[] = [];
  const clientGateway = fakeGateway((req) => {
    clientPrompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.unsubmitted_invoices",
      category: "unknown",
      month: "none",
      client: "none",
    });
  });
  await askClerk(`And unsubmitted? ${SALT}`, clientAskerId, clientGateway, {
    firmId: firmA,
    clientScoped: true,
    clientPartyId: partyA2,
    previousCaseId: staffCase.id,
  });
  assert.ok(
    !clientPrompts[0].includes("Previous question context"),
    "another user's case threads no context for a client (SEC-03)",
  );

  // The client's OWN previous case still threads.
  const ownFirstGateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.failed_submissions",
      category: "unknown",
      month: "none",
      client: "none",
    }),
  );
  const ownCase = await askClerk(
    `What failed? ${SALT}`,
    clientAskerId,
    ownFirstGateway,
    { firmId: firmA, clientScoped: true, clientPartyId: partyA2 },
  );
  const ownPrompts: string[] = [];
  const ownFollowGateway = fakeGateway((req) => {
    ownPrompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.unsubmitted_invoices",
      category: "unknown",
      month: "none",
      client: "none",
    });
  });
  await askClerk(`And unsubmitted too? ${SALT}`, clientAskerId, ownFollowGateway, {
    firmId: firmA,
    clientScoped: true,
    clientPartyId: partyA2,
    previousCaseId: ownCase.id,
  });
  assert.ok(
    ownPrompts[0].includes("Previous question context"),
    "the client's own thread still carries context",
  );
  assert.ok(ownPrompts[0].includes("data.failed_submissions"));

  // Firm staff are NOT sub-tenant scoped: a different staff user threading
  // the first staff user's case keeps its context (unchanged behaviour).
  const staff2Prompts: string[] = [];
  const staff2Gateway = fakeGateway((req) => {
    staff2Prompts.push(req.user as string);
    return JSON.stringify({
      claimKey: "data.unsubmitted_invoices",
      category: "unknown",
      month: "none",
      client: "none",
    });
  });
  await askClerk(`And unsubmitted, colleague? ${SALT}`, secondStaffId, staff2Gateway, {
    firmId: firmA,
    previousCaseId: staffCase.id,
  });
  assert.ok(
    staff2Prompts[0].includes("Previous question context"),
    "firm staff threading stays firm-wide",
  );
});

// ---- Answer links (round 7) -------------------------------------------------

// Resolve an invoice row by id on the raw pool (test runs as the DB owner).
const invoiceById = async (id: string) => {
  const [row] = await getDb()
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      supplierPartyId: invoicesTable.supplierPartyId,
      firmId: invoicesTable.firmId,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id))
    .limit(1);
  return row;
};

test("a data answer carries open-the-invoice links with real invoice ids", async () => {
  const result = await lookup("data.overdue_submissions");
  assert.ok(result?.links, "links present when the sample names invoices");
  assert.equal(result.links.length, 3);
  // Labels mirror the sample fact exactly, in the same order.
  const sample = result.facts.find((f) => f.key === "sample")?.value;
  assert.deepEqual(
    result.links.map((l) => l.label),
    sample?.split(", "),
    "link labels are exactly the sampled invoice numbers",
  );
  for (const link of result.links) {
    assert.equal(link.kind, "invoice");
    const row = await invoiceById(link.id);
    assert.ok(row, "every link id is a real invoice row");
    assert.equal(row.invoiceNumber, link.label, "id and label name the same invoice");
    assert.equal(row.firmId, firmA, "links never leave the asker's firm");
  }

  // The full ask path spreads the links into the stored answer.
  const gateway = fakeGateway(() =>
    JSON.stringify({ claimKey: "data.overdue_submissions", category: "unknown" }),
  );
  const kase = await askClerk(`Overdue with links? ${SALT}`, askerId, gateway, {
    firmId: firmA,
  });
  assert.equal(kase.status, "approved");
  assert.equal(kase.answer?.links?.length, 3);
  assert.deepEqual(
    kase.answer?.links?.map((l) => l.label).sort(),
    result.links.map((l) => l.label).sort(),
  );
});

test("chase-list answers link the named invoices; linkless intents stay linkless", async () => {
  const chase = await lookup("data.chase_list");
  assert.ok(chase?.links, "firm-wide chase list links its rows");
  assert.equal(chase.links.length, 2);
  assert.ok(chase.links.some((l) => l.label === RECEIVABLE_NUM));
  for (const link of chase.links) {
    const row = await invoiceById(link.id);
    assert.equal(row?.invoiceNumber, link.label);
  }
  // Per-client branch links too (partyA owns both chase-eligible invoices).
  const scoped = await inClerkScope(firmA, () =>
    runDataIntent("data.chase_list", firmA, {
      clientPartyId: partyA,
      clientName: `DI Party A ${SALT}`,
    }),
  );
  assert.ok(scoped?.links);
  assert.equal(scoped.links.length, 2);

  // Deliberately linkless: debtor rankings, inflow projections, allowance.
  assert.equal((await lookup("data.outstanding_receivables"))?.links, undefined);
  assert.equal((await lookup("data.expected_inflows"))?.links, undefined);
  assert.equal((await lookup("data.clerk_allowance"))?.links, undefined);
  // An empty sample carries no links key at all (additive, never noisy).
  const emptyScoped = await inClerkScope(firmA, () =>
    runDataIntent("data.failed_submissions", firmA, {
      clientPartyId: partyA2,
      clientName: `DI Party Z ${SALT}`,
    }),
  );
  assert.equal(emptyScoped?.facts.find((f) => f.key === "count")?.value, "0");
  assert.equal(emptyScoped?.links, undefined);
});

test("a client-scoped ask's links stay within the client's own invoices (SEC-03)", async () => {
  const gateway = fakeGateway(() =>
    JSON.stringify({
      claimKey: "data.overdue_submissions",
      category: "unknown",
      month: "none",
      client: "none",
    }),
  );
  const kase = await askClerk(
    `Overdue links for me? ${SALT}`,
    clientAskerId,
    gateway,
    { firmId: firmA, clientScoped: true, clientPartyId: partyA2 },
  );
  assert.equal(kase.status, "approved");
  assert.ok(kase.answer?.links);
  assert.equal(
    kase.answer.links.length,
    1,
    "only the caller's own overdue invoice is linked",
  );
  assert.equal(kase.answer.links[0].label, CLIENT2_OVERDUE_NUM);
  const row = await invoiceById(kase.answer.links[0].id);
  assert.equal(
    row?.supplierPartyId,
    partyA2,
    "the linked id is the caller's OWN invoice, never a sibling's",
  );
});

test("register answers and refusals carry no links", async () => {
  const claimKey = `test.link_free_claim_${SALT}`;
  await getDb().insert(claimRecordsTable).values({
    claimKey,
    version: 1,
    state: "active",
    title: `Link-free claim ${SALT}`,
    proposition: "The standard VAT rate is {rate}.",
    protectedFacts: [
      { key: "rate", label: "Standard rate", kind: "rate", value: "7.5", unit: "%" },
    ],
    citation: "Test Act s.1",
    effectiveFrom: "2020-01-01",
    createdBy: askerId,
  });
  const claimGateway = fakeGateway(() =>
    JSON.stringify({ claimKey, category: "unknown" }),
  );
  const claimCase = await askClerk(`What is the rate? ${SALT}`, askerId, claimGateway, {
    firmId: firmA,
  });
  assert.equal(claimCase.status, "approved");
  assert.equal(claimCase.answer?.claimKey, claimKey);
  assert.equal(claimCase.answer?.links, undefined, "claim answers carry no links");

  const refuseGateway = fakeGateway(() =>
    JSON.stringify({ claimKey: "none", category: "unknown" }),
  );
  const refused = await askClerk(`Unanswerable? ${SALT}`, askerId, refuseGateway, {
    firmId: firmA,
  });
  assert.equal(refused.answer?.answered, false);
  assert.equal(refused.answer?.links, undefined, "refusals carry no links");
});
