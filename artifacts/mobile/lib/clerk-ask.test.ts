import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClerkAnswer, ClerkAnswerLink } from "@workspace/api-client-react";
import {
  answerLinks,
  answerSections,
  answerSourceNote,
  askableQuestion,
  dataAnswerScope,
  feedbackToSubmit,
  followupPinsLine,
  heldAnswer,
  holdsFollowupCase,
  planLine,
  QUESTION_MAX,
  QUESTION_MIN,
  sectionKey,
  SUGGESTED_QUESTIONS,
} from "./clerk-ask.ts";

// The suggested chips are a vetted, CLIENT-SAFE set: this screen serves
// client_users (SEC-03), who are only offered the CLIENT_SAFE_DATA_INTENTS
// subset server-side — a chip outside that allowlist is a one-tap refusal
// for a client. The exact phrasings are pinned so a well-meaning reword
// can't silently land in a firm-only intent.

test("suggested chips mirror the SME app's client-safe phrasings exactly", () => {
  assert.deepEqual(
    [...SUGGESTED_QUESTIONS],
    [
      "What's overdue?",
      "What did we submit this month?",
      "What invoices haven't gone out?",
      "What's been outstanding longest?",
      // Ask 2.0's month-over-month delta intent, appended fifth.
      "How does this month compare to last month?",
    ],
  );
});

test("every suggested chip is submittable as-is", () => {
  for (const q of SUGGESTED_QUESTIONS) {
    assert.equal(askableQuestion(q), q);
  }
});

test("heldAnswer mirrors the console's tested persistence semantic, carrying the case id", () => {
  const first: ClerkAnswer = {
    answered: true,
    proposition: "3 invoices were submitted.",
  };
  const refusal: ClerkAnswer = {
    answered: false,
    refusalReason: "Not covered by an approved claim.",
  };
  // A success replaces the held answer — a refusal IS the newest answer —
  // and threads the answered case's id alongside it.
  const held = heldAnswer(null, {
    type: "success",
    answer: first,
    caseId: "case-1",
  });
  assert.deepEqual(held, { answer: first, caseId: "case-1" });
  assert.deepEqual(
    heldAnswer(held, { type: "success", answer: refusal, caseId: "case-2" }),
    { answer: refusal, caseId: "case-2" },
  );
  // A missing id degrades to null rather than inventing one.
  assert.deepEqual(heldAnswer(null, { type: "success", answer: first }), {
    answer: first,
    caseId: null,
  });
  // A success WITHOUT an answer payload clears a stale one (never keeps it).
  assert.equal(
    heldAnswer(held, { type: "success", answer: undefined, caseId: "case-3" }),
    null,
  );
  assert.equal(
    heldAnswer(held, { type: "success", answer: null, caseId: "case-3" }),
    null,
  );
  // An error keeps the previous answer — still the newest truth given —
  // with the SAME case id, so feedback still lands on the shown answer.
  assert.equal(heldAnswer(held, { type: "error" }), held);
  assert.equal(heldAnswer(null, { type: "error" }), null);
});

test("answerLinks keeps only invoice links that carry an id, in order", () => {
  const links: ClerkAnswerLink[] = [
    { label: "INV-001", kind: "invoice", id: "inv-1" },
    // The server named an invoice the asker cannot open — no dead button.
    { label: "INV-002", kind: "invoice", id: null },
    { label: "INV-003", kind: "invoice" },
    { label: "INV-004", kind: "invoice", id: "inv-4" },
  ];
  assert.deepEqual(answerLinks({ links }), [
    { label: "INV-001", id: "inv-1" },
    { label: "INV-004", id: "inv-4" },
  ]);
  assert.deepEqual(answerLinks({}), []);
  assert.deepEqual(answerLinks({ links: [] }), []);
});

test("feedbackToSubmit switches thumbs and swallows a repeat press", () => {
  assert.equal(feedbackToSubmit(null, "helpful"), "helpful");
  assert.equal(feedbackToSubmit(null, "not_helpful"), "not_helpful");
  assert.equal(feedbackToSubmit("helpful", "not_helpful"), "not_helpful");
  assert.equal(feedbackToSubmit("not_helpful", "helpful"), "helpful");
  // The already-selected thumb again: nothing new to tell the server.
  assert.equal(feedbackToSubmit("helpful", "helpful"), null);
  assert.equal(feedbackToSubmit("not_helpful", "not_helpful"), null);
});

test("askableQuestion trims and enforces the contract bounds", () => {
  assert.equal(QUESTION_MIN, 3);
  assert.equal(QUESTION_MAX, 2000);
  assert.equal(askableQuestion("  What's overdue?  "), "What's overdue?");
  assert.equal(askableQuestion(""), null);
  assert.equal(askableQuestion("ab"), null);
  // Whitespace padding can't smuggle an under-length question through.
  assert.equal(askableQuestion("  ab  "), null);
  assert.equal(askableQuestion("abc"), "abc");
  const atMax = "q".repeat(QUESTION_MAX);
  assert.equal(askableQuestion(atMax), atMax);
  assert.equal(askableQuestion("q".repeat(QUESTION_MAX + 1)), null);
});

test("dataAnswerScope joins the resolved labels and skips blanks", () => {
  assert.equal(dataAnswerScope(undefined), "");
  assert.equal(dataAnswerScope({}), "");
  assert.equal(dataAnswerScope({ monthLabel: "June 2026" }), "June 2026");
  assert.equal(
    dataAnswerScope({ monthLabel: "June 2026", clientName: "Acme Ltd" }),
    "June 2026 · Acme Ltd",
  );
  // A blank label contributes nothing rather than an empty segment.
  assert.equal(
    dataAnswerScope({ monthLabel: "   ", clientName: "Acme Ltd" }),
    "Acme Ltd",
  );
});

test("answerSourceNote marks a data answer as from-your-records with scope", () => {
  assert.equal(
    answerSourceNote({
      dataIntent: "data.overdue_invoices",
      dataParams: { monthLabel: "June 2026", clientName: "Acme Ltd" },
      citation: "Computed from your invoice records",
    }),
    "From your records (June 2026 · Acme Ltd) · Computed from your invoice records",
  );
  // Unscoped lookup: no empty parentheses.
  assert.equal(
    answerSourceNote({
      dataIntent: "data.overdue_invoices",
      citation: "Computed live",
    }),
    "From your records · Computed live",
  );
  assert.equal(
    answerSourceNote({ dataIntent: "data.overdue_invoices" }),
    "From your records",
  );
});

// ---- Ask 2.0 (contract 0.56.0) ---------------------------------------------

test("answerSections normalizes absence to an empty array", () => {
  const section = {
    title: "June 2026",
    text: "3 invoices were submitted.",
    facts: [],
  };
  assert.deepEqual(answerSections(undefined), []);
  assert.deepEqual(answerSections(null), []);
  assert.deepEqual(answerSections({}), []);
  assert.deepEqual(answerSections({ sections: [] }), []);
  assert.deepEqual(answerSections({ sections: [section] }), [section]);
});

test("planLine joins the plan titles verbatim, in server order", () => {
  assert.equal(
    planLine({
      plan: [
        { key: "data.submitted_this_month", title: "This month's submissions" },
        { key: "data.month_delta", title: "Month-on-month change" },
      ],
    }),
    "Answered using: This month's submissions · Month-on-month change",
  );
  assert.equal(
    planLine({ plan: [{ key: "data.month_delta", title: "Month vs month" }] }),
    "Answered using: Month vs month",
  );
});

test("planLine yields an empty string when there is no plan, so the line is omitted", () => {
  assert.equal(planLine(undefined), "");
  assert.equal(planLine(null), "");
  assert.equal(planLine({}), "");
  assert.equal(planLine({ plan: [] }), "");
  // A blank title contributes nothing rather than a dangling separator.
  assert.equal(
    planLine({
      plan: [
        { key: "a", title: "  " },
        { key: "b", title: "Overdue invoices" },
      ],
    }),
    "Answered using: Overdue invoices",
  );
});

test("followupPinsLine shows the display pins a follow-up will keep", () => {
  assert.equal(
    followupPinsLine({
      pins: { monthLabel: "June 2026", clientName: "Adaeze Foods Ltd" },
    }),
    "Follow-ups keep: June 2026 · Adaeze Foods Ltd",
  );
  assert.equal(
    followupPinsLine({ pins: { monthLabel: "June 2026" } }),
    "Follow-ups keep: June 2026",
  );
  assert.equal(
    followupPinsLine({ pins: { clientName: "Adaeze Foods Ltd" } }),
    "Follow-ups keep: Adaeze Foods Ltd",
  );
});

test("followupPinsLine yields an empty string when nothing displayable is pinned", () => {
  assert.equal(followupPinsLine(undefined), "");
  assert.equal(followupPinsLine(null), "");
  assert.equal(followupPinsLine({}), "");
  assert.equal(followupPinsLine({ pins: {} }), "");
  // Machine pins (ids, ISO dates) never render — display labels only.
  assert.equal(
    followupPinsLine({
      pins: { monthStart: "2026-06-01", clientPartyId: "party-1" },
    }),
    "",
  );
  // Blank labels contribute nothing rather than a dangling separator.
  assert.equal(
    followupPinsLine({ pins: { monthLabel: "  ", clientName: "Acme" } }),
    "Follow-ups keep: Acme",
  );
});

test("sectionKey builds the section-indexed fact-row testID, matching the SME pattern", () => {
  assert.equal(sectionKey(0, "count"), "row-fact-0-count");
  assert.equal(sectionKey(1, "count"), "row-fact-1-count");
  assert.equal(sectionKey(2, "total"), "row-fact-2-total");
  // Never collides with a flat row's un-indexed `row-fact-<key>` id.
  assert.notEqual(sectionKey(0, "count"), "row-fact-count");
});

test("holdsFollowupCase widens the holding rule to sections and pins", () => {
  const base: ClerkAnswer = { answered: true, proposition: "…" };
  // A data answer threads, as before.
  assert.equal(
    holdsFollowupCase({ ...base, dataIntent: "data.overdue_invoices" }),
    true,
  );
  // A multi-intent answer threads even without a flat dataIntent.
  assert.equal(
    holdsFollowupCase({
      ...base,
      sections: [{ title: "This month", text: "3 submitted.", facts: [] }],
    }),
    true,
  );
  // Pinned scope threads — machine pins included, display labels or not.
  assert.equal(
    holdsFollowupCase({ ...base, pins: { monthLabel: "June 2026" } }),
    true,
  );
  assert.equal(
    holdsFollowupCase({ ...base, pins: { clientPartyId: "party-1" } }),
    true,
  );
  // Register-claim answers, refusals, and empty carriers don't thread.
  assert.equal(holdsFollowupCase(null), false);
  assert.equal(holdsFollowupCase(undefined), false);
  assert.equal(
    holdsFollowupCase({ ...base, claimKey: "vat.standard_rate" }),
    false,
  );
  assert.equal(
    holdsFollowupCase({
      answered: false,
      refusalReason: "Not covered.",
      pins: { monthLabel: "June 2026" },
    }),
    false,
  );
  assert.equal(holdsFollowupCase({ ...base, sections: [], pins: {} }), false);
  assert.equal(
    holdsFollowupCase({ ...base, pins: { monthLabel: "  " } }),
    false,
  );
});

test("answerSourceNote cites the approved claim for register answers", () => {
  assert.equal(
    answerSourceNote({
      citation: "VAT Act s.4",
      claimKey: "vat.standard_rate",
      claimVersion: 3,
    }),
    "Source: VAT Act s.4 · approved claim vat.standard_rate v3",
  );
  assert.equal(answerSourceNote({ citation: "VAT Act s.4" }), "Source: VAT Act s.4");
  // A claim without a version number never renders "vundefined".
  assert.equal(
    answerSourceNote({ claimKey: "vat.standard_rate" }),
    "approved claim vat.standard_rate",
  );
  assert.equal(answerSourceNote({}), "");
});
