import { test } from "node:test";
import assert from "node:assert/strict";
import {
  billStatusLabel,
  billStatusTone,
  canFlag,
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
