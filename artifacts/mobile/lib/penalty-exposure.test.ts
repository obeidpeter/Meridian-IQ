import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENALTY_EXPOSURE_FIX_LINE,
  penaltyExposureLine,
  penaltyExposureNote,
} from "./penalty-exposure.ts";

// The honesty rules are the load-bearing piece: the headline is always the
// SMALL-band estimate ("lowest turnover band"), not an official penalty or
// advice. Completing submission work must not promise a penalty waiver.

test("penaltyExposureLine: plural counts, the floor, per-invoice, and the top band", () => {
  assert.equal(
    penaltyExposureLine({
      overdueCount: 3,
      exposure: { small: "75000", large: "300000" },
      perInvoice: { small: "25000" },
    }),
    "3 invoices are past the statutory submission window. Valo's s.104 planning estimate is ₦75,000 at the lowest turnover band (₦25,000 per invoice), rising to ₦300,000 at the highest band. These are not official penalty amounts.",
  );
});

test("penaltyExposureLine: the singular reads as one invoice", () => {
  const line = penaltyExposureLine({
    overdueCount: 1,
    exposure: { small: "25000", large: "100000" },
    perInvoice: { small: "25000" },
  });
  assert.match(line, /^1 invoice is past the statutory submission window/);
  assert.match(line, /planning estimate is ₦25,000/);
  assert.match(line, /lowest turnover band/);
});

test("the fix line asks for submission without promising a penalty waiver", () => {
  assert.match(
    PENALTY_EXPOSURE_FIX_LINE,
    /Submit overdue invoices to resolve the outstanding submission work/,
  );
  assert.match(
    PENALTY_EXPOSURE_FIX_LINE,
    /does not guarantee that any penalty will be waived/,
  );
});

test("penaltyExposureNote: estimate-not-advice, with the as-of date", () => {
  assert.equal(
    penaltyExposureNote("29 Jul 2026"),
    "Based on Valo's planning assumptions, not legal or tax advice. Check current official notices or speak to a tax advisor. As of 29 Jul 2026.",
  );
});
