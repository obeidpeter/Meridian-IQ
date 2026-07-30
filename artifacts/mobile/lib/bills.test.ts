import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billStatusLabel,
  billStatusTone,
  canFlag,
  MISSING_BILLS_FOOTER,
  MISSING_BILLS_HEADER,
  missingBillLine,
  missingBillsBannerMessage,
  verificationChip,
} from "./bills.ts";

// The flag gate is the load-bearing piece: a payment flag records settlement
// EVIDENCE against the bill (source payer_flag) — "paid" is terminal, so the
// UI must never offer another flag once the evidence says settled.

test("billStatusLabel reads buyer-side: open means money still to pay", () => {
  assert.equal(billStatusLabel("open"), "Unpaid");
  assert.equal(billStatusLabel("scheduled"), "Scheduled");
  assert.equal(billStatusLabel("paid"), "Paid");
});

test("billStatusLabel degrades off-contract statuses instead of crashing", () => {
  assert.equal(billStatusLabel("disputed"), "Disputed");
  assert.equal(billStatusLabel(""), "Unknown");
});

test("billStatusTone mirrors the web pills: slate/amber/emerald", () => {
  assert.equal(billStatusTone("open"), "neutral");
  assert.equal(billStatusTone("scheduled"), "warning");
  assert.equal(billStatusTone("paid"), "success");
  // Unknown statuses stay visually quiet.
  assert.equal(billStatusTone("disputed"), "neutral");
});

test("a paid bill accepts no further flags — paid is terminal", () => {
  assert.equal(canFlag("paid", "scheduled"), false);
  assert.equal(canFlag("paid", "paid"), false);
});

test("a scheduled bill can be marked paid but not re-scheduled", () => {
  assert.equal(canFlag("scheduled", "paid"), true);
  assert.equal(canFlag("scheduled", "scheduled"), false);
});

test("an open bill accepts either flag", () => {
  assert.equal(canFlag("open", "scheduled"), true);
  assert.equal(canFlag("open", "paid"), true);
});

test("off-contract statuses stay flaggable rather than dead-ending the row", () => {
  assert.equal(canFlag("disputed", "scheduled"), true);
  assert.equal(canFlag("disputed", "paid"), true);
});

const PATTERN = {
  supplierName: "Lagos Power Ltd",
  currency: "NGN",
  medianAmount: "45000.00",
  medianGapDays: 30,
  count: 6,
  lastIssueDate: "2026-05-28",
  expectedByDate: "2026-06-30",
};

test("missingBillLine: the vendor habit in the web page's exact shape", () => {
  assert.equal(
    missingBillLine(PATTERN),
    "Lagos Power Ltd has billed about ₦45,000 roughly every 30 days (6 bills on record, last 28 May 2026) — this cycle's bill was expected by 30 Jun 2026 and has not been captured.",
  );
});

test("missingBillLine: a foreign-currency habit never masquerades as naira", () => {
  assert.match(
    missingBillLine({ ...PATTERN, currency: "USD", medianAmount: "120.00" }),
    /billed about USD 120\.00 roughly every/,
  );
});

test("missingBillsBannerMessage: header, one line per pattern, hedge footer", () => {
  const message = missingBillsBannerMessage([
    PATTERN,
    { ...PATTERN, supplierName: "Ikeja Internet" },
  ]);
  const blocks = message.split("\n\n");
  assert.equal(blocks.length, 4);
  assert.equal(blocks[0], MISSING_BILLS_HEADER);
  assert.match(blocks[1], /^Lagos Power Ltd has billed/);
  assert.match(blocks[2], /^Ikeja Internet has billed/);
  assert.equal(blocks[3], MISSING_BILLS_FOOTER);
  // The hedge keeps its honesty markers.
  assert.match(MISSING_BILLS_FOOTER, /Advisory only/);
  assert.match(MISSING_BILLS_FOOTER, /unclaimed input VAT/);
});

test("verificationChip maps the stored result; never-checked bills get no chip", () => {
  assert.deepEqual(verificationChip({ valid: true }), {
    label: "Stamp valid",
    tone: "success",
  });
  assert.deepEqual(verificationChip({ valid: false }), {
    label: "Stamp not found",
    tone: "critical",
  });
  assert.equal(verificationChip(null), null);
  assert.equal(verificationChip(undefined), null);
});
