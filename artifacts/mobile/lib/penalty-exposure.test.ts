import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENALTY_EXPOSURE_FIX_LINE,
  penaltyExposureLine,
  penaltyExposureNote,
} from "./penalty-exposure.ts";

// The honesty rules are the load-bearing piece: the headline is always the
// SMALL-band floor ("at least", "lowest turnover band"), and the note says
// estimate, not advice.

test("penaltyExposureLine: plural counts, the floor, per-invoice, and the top band", () => {
  assert.equal(
    penaltyExposureLine({
      overdueCount: 3,
      exposure: { small: "75000", large: "300000" },
      perInvoice: { small: "25000" },
    }),
    "3 invoices are past the statutory submission window — at least ₦75,000 of potential s.104 exposure at the lowest turnover band (₦25,000 per invoice; higher bands reach ₦300,000).",
  );
});

test("penaltyExposureLine: the singular reads as one invoice", () => {
  const line = penaltyExposureLine({
    overdueCount: 1,
    exposure: { small: "25000", large: "100000" },
    perInvoice: { small: "25000" },
  });
  assert.match(line, /^1 invoice is past the statutory submission window/);
  assert.match(line, /at least ₦25,000/);
  assert.match(line, /lowest turnover band/);
});

test("the fix line states the exposure is removable", () => {
  assert.match(PENALTY_EXPOSURE_FIX_LINE, /Submitting .* removes this exposure/);
});

test("penaltyExposureNote: estimate-not-advice, with the as-of date", () => {
  assert.equal(
    penaltyExposureNote("29 Jul 2026"),
    "An estimate under MeridianIQ's published penalty model — not legal or tax advice. As of 29 Jul 2026.",
  );
});
