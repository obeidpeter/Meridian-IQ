import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
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
const RECEIVABLE_NUM = `REC-${SALT}`;
const FOREIGN_NUM = `FOREIGN-${SALT}`;

before(async () => {
  await saveAndEnableClerkFlag();
  const db = getDb();
  await db.insert(firmsTable).values([
    { id: firmA, name: `Data Intents Firm A ${SALT}` },
    { id: firmB, name: `Data Intents Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    { id: partyA, type: "client_business", legalName: `DI Party A ${SALT}` },
    { id: partyB, type: "client_business", legalName: `DI Party B ${SALT}` },
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
  await db.insert(submissionAttemptsTable).values({
    invoiceId: acceptedId,
    rail: "rail_primary",
    attemptNo: 1,
    idempotencyKey: `di-${SALT}`,
    status: "accepted",
  });
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
  assert.equal(count?.value, "2");
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

  // Unsubmitted = both overdue drafts + the due-soon validated invoice.
  const unsubmitted = await lookup("data.unsubmitted_invoices");
  assert.equal(unsubmitted?.facts.find((f) => f.key === "count")?.value, "3");
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
