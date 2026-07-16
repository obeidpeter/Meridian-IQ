import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  engagementsTable,
  firmsTable,
  partiesTable,
  invoicesTable,
  usersTable,
  submissionAttemptsTable,
} from "@workspace/db";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window.ts";
import { askClerk } from "./ask.ts";
import {
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
const askerId = randomUUID();

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
  ]);
  // Engagements make both parties firm A's clients — the source of the
  // closed client-key list ask.ts offers the classifier.
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
  ]);
  await db
    .insert(usersTable)
    .values({ id: askerId, email: `di-asker-${SALT}@test.example` })
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
  ]);
  await db.insert(submissionAttemptsTable).values([
    {
      invoiceId: acceptedId,
      rail: "rail_primary",
      attemptNo: 1,
      idempotencyKey: `di-${SALT}`,
      status: "accepted",
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
