import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, clerkCasesTable, firmsTable, usersTable } from "@workspace/db";
import { computeClaimGaps, refusalCode } from "./claim-gaps.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

// Claim-gap mining. Pinned invariants:
//  - every refusal sentence ask.ts can produce maps to its stable code — a
//  reworded refusal fails HERE instead of silently landing in "other";
//  - the report is deterministic SQL + string matching (zero model calls):
//  refusals cluster by code, and the uncovered list carries the newest
//  questions no approved claim covers, firm-attributed via LEFT JOIN;
//  - the window excludes old cases; answered questions are never refusals.

const SALT = makeRunSalt();
const userId = randomUUID();
const firmId = randomUUID();
const FIRM_NAME = `Gap Firm ${SALT}`;

// ask.ts's REFUSAL_PREFIX, reproduced verbatim: stored reasons always carry it.
const PREFIX = "I can only answer from the approved claims register. ";

// Every refusal sentence askClerk can emit (ask.ts), verbatim, with its code.
// The category-mismatch sentence is dynamic — reproduced with one scope pair.
const SENTENCES: Array<{ sentence: string; code: string }> = [
  {
    sentence:
      "The register has no active claims yet, so this question has been escalated to an operator.",
    code: "no_active_claims",
  },
  {
    sentence:
      "The question could not be classified reliably, so it has been escalated to an operator.",
    code: "classification_failed",
  },
  {
    sentence:
      "This question is not covered by an approved claim, so it has been escalated to an operator.",
    code: "no_matching_claim",
  },
  {
    sentence:
      "The month in the question could not be resolved, so it has been escalated to an operator.",
    code: "month_unresolved",
  },
  {
    sentence:
      "That lookup always answers as of today and cannot be filtered to a month. Ask about rail submissions for month-by-month figures.",
    code: "month_not_supported",
  },
  {
    sentence:
      "The client named in the question could not be resolved, so it has been escalated to an operator.",
    code: "client_unresolved",
  },
  {
    sentence:
      "That lookup covers the whole firm and cannot be filtered to one client.",
    code: "client_not_supported",
  },
  {
    sentence:
      "The firm-record lookup failed, so the question has been escalated to an operator.",
    code: "lookup_failed",
  },
  {
    sentence:
      "The register does not have exactly one active claim for this topic, so it has been escalated to an operator.",
    code: "ambiguous_claims",
  },
  {
    sentence:
      "The matching claim applies to B2B transactions, but the question appears to be about B2C. It has been escalated to an operator.",
    code: "category_mismatch",
  },
];

const uncoveredReason =
  PREFIX +
  "This question is not covered by an approved claim, so it has been escalated to an operator.";

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `claim-gaps-${SALT}@test.local` })
    .onConflictDoNothing();
  await db
    .insert(firmsTable)
    .values({ id: firmId, name: FIRM_NAME })
    .onConflictDoNothing();
});

test("refusalCode maps every sentence ask.ts produces to its stable code", () => {
  for (const { sentence, code } of SENTENCES) {
    assert.equal(refusalCode(PREFIX + sentence), code, sentence);
  }
  // A category-mismatch with a different scope pair still matches the
  // dynamic fragments.
  assert.equal(
    refusalCode(
      PREFIX +
        "The matching claim applies to B2C transactions, but the question appears to be about B2B. It has been escalated to an operator.",
    ),
    "category_mismatch",
  );
  // Anything unrecognized is "other", never an error.
  assert.equal(refusalCode("Some future sentence nobody mapped."), "other");
  assert.equal(refusalCode(""), "other");
});

test("the report clusters refusals, surfaces uncovered questions, and honours the window", async () => {
  const db = getDb();
  const qFirm = `Can we claim capital allowances? ${SALT}`;
  const qOperator = `Is WHT creditable against CIT? ${SALT}`;
  const qLookup = `Who owes us this week? ${SALT}`;
  const qAnswered = `What is the VAT rate? ${SALT}`;
  const qOld = `Stale question outside the window ${SALT}`;

  await db.insert(clerkCasesTable).values([
    // Two uncovered refusals: one firm-attributed, one operator ask (no firm).
    {
      kind: "question",
      status: "escalated",
      question: qFirm,
      firmId,
      createdBy: userId,
      answer: { answered: false, refusalReason: uncoveredReason },
    },
    {
      kind: "question",
      status: "escalated",
      question: qOperator,
      createdBy: userId,
      answer: { answered: false, refusalReason: uncoveredReason },
    },
    // A different refusal cause: clusters under lookup_failed, never uncovered.
    {
      kind: "question",
      status: "escalated",
      question: qLookup,
      firmId,
      createdBy: userId,
      answer: {
        answered: false,
        refusalReason:
          PREFIX +
          "The firm-record lookup failed, so the question has been escalated to an operator.",
      },
    },
    // Answered questions are not refusals.
    {
      kind: "question",
      status: "approved",
      question: qAnswered,
      firmId,
      createdBy: userId,
      answer: { answered: true, proposition: "7.5%" },
    },
    // An uncovered refusal OUTSIDE the 90-day window: invisible to the report.
    {
      kind: "question",
      status: "escalated",
      question: qOld,
      firmId,
      createdBy: userId,
      answer: { answered: false, refusalReason: uncoveredReason },
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    },
  ]);

  const report = await computeClaimGaps(90);
  assert.equal(report.windowDays, 90);
  // Platform-wide report over a shared test DB: sibling suites also create
  // question cases, so totals are lower bounds and rows are matched by our
  // salted questions.
  assert.ok(report.totalQuestions >= 4);
  assert.ok(report.refusedTotal >= 3);

  const count = (code: string): number =>
    report.byReason.find((r) => r.code === code)?.count ?? 0;
  assert.ok(count("no_matching_claim") >= 2);
  assert.ok(count("lookup_failed") >= 1);
  // Sorted by count descending.
  for (let i = 1; i < report.byReason.length; i++) {
    assert.ok(report.byReason[i - 1].count >= report.byReason[i].count);
  }

  const uncoveredFirm = report.uncovered.find((u) => u.question === qFirm);
  const uncoveredOp = report.uncovered.find((u) => u.question === qOperator);
  assert.ok(uncoveredFirm, "the firm's uncovered question is listed");
  assert.equal(uncoveredFirm!.firmName, FIRM_NAME);
  assert.ok(uncoveredOp, "the operator's uncovered question is listed");
  assert.equal(uncoveredOp!.firmName, null, "operator asks carry no firm");
  assert.ok(uncoveredFirm!.createdAt instanceof Date);
  // Only no_matching_claim refusals are uncovered; answered and other-cause
  // questions never appear, and the old case is outside the window.
  assert.equal(
    report.uncovered.some((u) =>
      [qLookup, qAnswered, qOld].includes(u.question),
    ),
    false,
  );
});
