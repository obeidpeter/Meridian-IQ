import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  getDb,
  chaseLogTable,
  engagementsTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  settlementEventsTable,
} from "@workspace/db";
import {
  computeChaseEffectiveness,
  summarizeChaseEffectiveness,
  type ChaseOutcomeRow,
} from "./chase-effectiveness.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Reminder effectiveness (round-16 idea #2). Pinned here:
//  - a settlement observed BEFORE the first reminder never credits it (the
//    invoice still counts as reminded-and-settled for the issue-to-settle
//    comparison, but not as a reminder success);
//  - the within-window share divides by MATURE reminders only (settled, or
//    first reminder old enough for the window to have run) — a reminder sent
//    yesterday cannot deflate the share;
//  - every aggregate honours the sample floor;
//  - the note pins correlation-not-causation;
//  - the SQL layer joins chase_log MIN/COUNT and the earliest payment
//    evidence per invoice, firm+client scoped.

function row(input: {
  issue?: string;
  fr?: string | null;
  reminders?: number;
  settled?: string | null;
}): ChaseOutcomeRow {
  return {
    issueDate: input.issue ?? "2026-06-01",
    firstReminderAt: input.fr ?? null,
    reminders: input.reminders ?? (input.fr ? 1 : 0),
    settledAt: input.settled ?? null,
  };
}

const ASOF = "2026-07-28";

test("shares and medians follow the reminder/settlement geometry", () => {
  const report = summarizeChaseEffectiveness(
    [
      // Settled 5 days after the first reminder: a within-window success.
      row({ fr: "2026-06-20T00:00:00.000Z", settled: "2026-06-25T00:00:00.000Z" }),
      // Settled 25 days after: mature, settled, but outside the window.
      row({
        fr: "2026-06-10T00:00:00.000Z",
        reminders: 2,
        settled: "2026-07-05T00:00:00.000Z",
      }),
      // Reminded 48 days ago, never settled: mature, no credit.
      row({ fr: "2026-06-10T00:00:00.000Z" }),
      // Settled BEFORE the first reminder: never credits the reminder.
      row({ fr: "2026-06-20T00:00:00.000Z", settled: "2026-06-15T00:00:00.000Z" }),
      // Unreminded settled invoices: 10 / 20 / 30 days issue-to-settle.
      row({ settled: "2026-06-11T00:00:00.000Z" }),
      row({ settled: "2026-06-21T00:00:00.000Z" }),
      row({ settled: "2026-07-01T00:00:00.000Z" }),
    ],
    ASOF,
  );
  assert.equal(report.remindedCount, 4);
  assert.equal(report.remindedSettledCount, 2, "the pre-reminder settlement is excluded");
  // The pre-reminder-settled invoice had no window to run, so it is in
  // NEITHER side of the share: 1 within-window over 3 mature.
  assert.equal(report.settledWithinShare, 0.3333);
  assert.equal(
    report.medianDaysReminderToSettle,
    null,
    "two credited settlements sit under the sample floor",
  );
  // Issue-to-settle: reminded {24, 34, 14} vs unreminded {10, 20, 30}.
  assert.equal(report.medianDaysToSettleReminded, 24);
  assert.equal(report.medianDaysToSettleUnreminded, 20);
  assert.match(report.note, /correlation, not causation/);
});

test("fresh reminders are immature and cannot deflate the share", () => {
  const fresh = "2026-07-20T00:00:00.000Z"; // 8 days before asOf < 14
  const report = summarizeChaseEffectiveness(
    [row({ fr: fresh }), row({ fr: fresh }), row({ fr: fresh })],
    ASOF,
  );
  assert.equal(report.remindedCount, 3);
  assert.equal(
    report.settledWithinShare,
    null,
    "no mature reminders → no share, not a zero",
  );
});

test("empty evidence answers with nulls, not zeros", () => {
  const report = summarizeChaseEffectiveness([], ASOF);
  assert.equal(report.remindedCount, 0);
  assert.equal(report.settledWithinShare, null);
  assert.equal(report.medianDaysReminderToSettle, null);
  assert.equal(report.medianDaysToSettleReminded, null);
  assert.equal(report.medianDaysToSettleUnreminded, null);
});

// ---- SQL layer -------------------------------------------------------------

const SALT = makeRunSalt();
const firmId = randomUUID();
const clientParty = randomUUID();
const buyerParty = randomUUID();
const actorId = randomUUID();

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

before(async () => {
  const db = getDb();
  await db.insert(firmsTable).values({ id: firmId, name: `Chase Fx ${SALT}` });
  await db.insert(partiesTable).values([
    { id: clientParty, type: "client_business", legalName: `Chase Fx Client ${SALT}` },
    { id: buyerParty, type: "buyer", legalName: `Chase Fx Buyer ${SALT}` },
  ]);
  await db.insert(engagementsTable).values({
    firmId,
    clientPartyId: clientParty,
    type: "retainer",
    title: `chase fx ${SALT}`,
  });
  const reminded = randomUUID();
  const unreminded = randomUUID();
  const draft = randomUUID();
  await db.insert(invoicesTable).values(
    [
      { id: reminded, status: "submitted" as const, issue: 30 },
      { id: unreminded, status: "submitted" as const, issue: 40 },
      // Drafts never enter the report: they were never submitted, so
      // "chase" and "settle" have no meaning for them.
      { id: draft, status: "draft" as const, issue: 30 },
    ].map((v, idx) => ({
      id: v.id,
      firmId,
      supplierPartyId: clientParty,
      buyerPartyId: buyerParty,
      invoiceNumber: `CHFX-${idx}-${SALT}`,
      status: v.status,
      issueDate: daysAgo(v.issue).toISOString().slice(0, 10),
      grandTotal: "100.00",
      subtotal: "100.00",
      vatTotal: "0.00",
    })),
  );
  await db.insert(chaseLogTable).values({
    firmId,
    invoiceId: reminded,
    stage: 1,
    loggedByUserId: actorId,
    createdAt: daysAgo(10),
  });
  await db.insert(settlementEventsTable).values([
    {
      invoiceId: reminded,
      source: "buyer_flag",
      amount: "100.00",
      paymentStatus: "paid",
      occurredAt: daysAgo(5),
    },
    {
      invoiceId: unreminded,
      source: "statement_match",
      amount: "100.00",
      occurredAt: daysAgo(20),
    },
  ]);
});

test("the SQL layer joins reminders and payment evidence per invoice", async () => {
  const report = await computeChaseEffectiveness(firmId, clientParty);
  assert.equal(report.remindedCount, 1, "the draft never appears");
  assert.equal(
    report.remindedSettledCount,
    1,
    "paid evidence 5 days after the reminder credits it",
  );
  // One reminded + one unreminded settlement: both under the sample floor.
  assert.equal(report.settledWithinShare, null);
  assert.equal(report.medianDaysToSettleUnreminded, null);
});
