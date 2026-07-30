import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTHORITY_LABELS,
  authorityLabel,
  localDayIso,
  NOTICE_TYPE_LABELS,
  noticeTypeLabel,
  obligationBadge,
  obligationLine,
} from "./obligations.ts";

// The badge is the load-bearing piece: only an OPEN obligation escalates on
// its deadline — a responded or closed one has been dealt with and must
// never read as overdue. todayIso is passed explicitly everywhere so each
// case is a pure function of its inputs (no hidden clock).

const TODAY = "2026-07-30";

test("label maps cover the server's closed catalogues", () => {
  assert.equal(NOTICE_TYPE_LABELS.assessment, "Assessment");
  assert.equal(NOTICE_TYPE_LABELS.information_request, "Information request");
  assert.equal(AUTHORITY_LABELS.firs, "FIRS");
  assert.equal(AUTHORITY_LABELS.state_irs, "State IRS");
  assert.equal(noticeTypeLabel("demand"), "Demand notice");
  assert.equal(authorityLabel("customs"), "Customs");
});

test("off-catalogue tokens degrade to a title-cased word, never a crash", () => {
  assert.equal(noticeTypeLabel("levy_review"), "Levy review");
  assert.equal(authorityLabel("lga"), "Lga");
  assert.equal(noticeTypeLabel(""), "Unknown");
});

test("an open obligation past its deadline is Overdue", () => {
  assert.deepEqual(obligationBadge("open", "2026-07-29", TODAY), {
    label: "Overdue",
    tone: "critical",
  });
  assert.deepEqual(obligationBadge("open", "2026-01-01", TODAY), {
    label: "Overdue",
    tone: "critical",
  });
});

test("due today through 7 days out is Due soon; day 8 is plain Open", () => {
  assert.deepEqual(obligationBadge("open", TODAY, TODAY), {
    label: "Due soon",
    tone: "warning",
  });
  assert.deepEqual(obligationBadge("open", "2026-08-06", TODAY), {
    label: "Due soon",
    tone: "warning",
  });
  assert.deepEqual(obligationBadge("open", "2026-08-07", TODAY), {
    label: "Open",
    tone: "info",
  });
});

test("responded and closed never escalate, even past the deadline", () => {
  assert.deepEqual(obligationBadge("responded", "2026-01-01", TODAY), {
    label: "Responded",
    tone: "success",
  });
  assert.deepEqual(obligationBadge("closed", "2026-01-01", TODAY), {
    label: "Closed",
    tone: "neutral",
  });
});

test("an off-contract status or unparseable date degrades calmly", () => {
  assert.deepEqual(obligationBadge("in_dispute", "2026-08-15", TODAY), {
    label: "In dispute",
    tone: "neutral",
  });
  assert.deepEqual(obligationBadge("open", "not-a-date", TODAY), {
    label: "Open",
    tone: "info",
  });
});

test("localDayIso renders the local calendar day, zero-padded", () => {
  // Local-time constructor so the expectation holds in any zone.
  assert.equal(localDayIso(new Date(2026, 6, 30, 23, 59)), "2026-07-30");
  assert.equal(localDayIso(new Date(2026, 0, 2, 0, 0)), "2026-01-02");
});

test("obligationLine joins reference, period and amount, skipping blanks", () => {
  assert.equal(
    obligationLine({
      reference: "FIRS/2026/0042",
      period: "2026-Q1",
      amount: "250000.00",
      currency: "NGN",
    }),
    "Ref FIRS/2026/0042 · 2026-Q1 · ₦250,000",
  );
  // A foreign-currency figure never masquerades as naira.
  assert.equal(
    obligationLine({ amount: "1200.00", currency: "USD" }),
    "USD 1200.00",
  );
  assert.equal(obligationLine({ period: "2025" }), "2025");
  assert.equal(
    obligationLine({ reference: null, period: null, amount: null }),
    "",
  );
});
