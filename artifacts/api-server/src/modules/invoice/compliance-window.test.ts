import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SUBMISSION_WINDOW_DAYS,
  daysUntil,
  isUnsubmitted,
  isStamped,
  submissionDeadline,
  penaltyRisk,
} from "./compliance-window.ts";

// The statutory window drives both the partner console (CON-02) and the SME
// dashboard (SME-05); these tests pin the shared arithmetic so a change here
// is a deliberate policy change, not drift.

test("daysUntil counts whole days and floors partial ones", () => {
  const from = new Date("2026-03-10T00:00:00Z");
  assert.equal(daysUntil(new Date("2026-03-17T00:00:00Z"), from), 7);
  assert.equal(daysUntil(from, from), 0);
  // 12 hours ahead is still "today": floors to 0.
  assert.equal(daysUntil(new Date("2026-03-10T12:00:00Z"), from), 0);
  // A target 23h in the past floors to -1 — already overdue.
  assert.equal(daysUntil(new Date("2026-03-09T01:00:00Z"), from), -1);
  assert.equal(daysUntil(new Date("2026-03-03T00:00:00Z"), from), -7);
});

test("status classifiers partition the lifecycle as documented", () => {
  const unsubmitted = ["draft", "validated"] as const;
  const stamped = ["stamped", "confirmed", "settled"] as const;
  const neither = ["submitted", "failed", "cancelled", "credited"] as const;

  for (const s of unsubmitted) {
    assert.equal(isUnsubmitted(s), true, `${s} is unsubmitted`);
    assert.equal(isStamped(s), false, `${s} is not stamped`);
  }
  for (const s of stamped) {
    assert.equal(isStamped(s), true, `${s} is stamped`);
    assert.equal(isUnsubmitted(s), false, `${s} is not unsubmitted`);
  }
  for (const s of neither) {
    assert.equal(isUnsubmitted(s), false, `${s} is not unsubmitted`);
    assert.equal(isStamped(s), false, `${s} is not stamped`);
  }
});

test("submissionDeadline is Lagos midnight after the statutory window", () => {
  // Nigeria is WAT (UTC+1, no DST): local midnight is 23:00Z the prior UTC
  // day. The deadline flips at the LAGOS calendar boundary — an invoice is
  // overdue the moment the local day turns, not an hour later at UTC midnight.
  assert.equal(
    submissionDeadline("2026-01-01").toISOString(),
    "2026-01-07T23:00:00.000Z",
  );
  // Month and year rollovers go through setUTCDate, immune to local TZ.
  assert.equal(
    submissionDeadline("2026-01-28").toISOString(),
    "2026-02-03T23:00:00.000Z",
  );
  assert.equal(
    submissionDeadline("2025-12-28").toISOString(),
    "2026-01-03T23:00:00.000Z",
  );
  // Leap year: Feb 29 exists in 2028.
  assert.equal(
    submissionDeadline("2028-02-25").toISOString(),
    "2028-03-02T23:00:00.000Z",
  );
  // Consistency with daysUntil: at the issue date's Lagos midnight the full
  // window remains.
  const issue = "2026-06-15";
  assert.equal(
    daysUntil(submissionDeadline(issue), new Date(`${issue}T00:00:00+01:00`)),
    SUBMISSION_WINDOW_DAYS,
  );
});

test("penaltyRisk: any overdue invoice or repeated failures mean high", () => {
  assert.equal(penaltyRisk(1, 0, false), "high");
  assert.equal(penaltyRisk(3, 0, false), "high");
  assert.equal(penaltyRisk(0, 2, false), "high");
  // High wins even when medium conditions are also present.
  assert.equal(penaltyRisk(1, 1, true), "high");
});

test("penaltyRisk: a single failure or a looming deadline means medium", () => {
  assert.equal(penaltyRisk(0, 1, false), "medium");
  assert.equal(penaltyRisk(0, 0, true), "medium");
  assert.equal(penaltyRisk(0, 1, true), "medium");
});

test("penaltyRisk: clean book is low", () => {
  assert.equal(penaltyRisk(0, 0, false), "low");
});
