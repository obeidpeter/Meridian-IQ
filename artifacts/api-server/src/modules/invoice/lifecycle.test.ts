import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canTransition,
  assertTransition,
  isTerminal,
  isPresentableAsEligible,
} from "./lifecycle.ts";

// Invoice lifecycle state machine (Appendix B, CORE-02, CORE-09).

test("happy path: draft -> validated -> submitted -> stamped -> confirmed -> settled", () => {
  assert.ok(canTransition("draft", "validated"));
  assert.ok(canTransition("validated", "submitted"));
  assert.ok(canTransition("submitted", "stamped"));
  assert.ok(canTransition("stamped", "confirmed"));
  assert.ok(canTransition("confirmed", "settled"));
});

test("failure and retry: submitted -> failed -> submitted", () => {
  assert.ok(canTransition("submitted", "failed"));
  assert.ok(canTransition("failed", "submitted"));
  assert.ok(canTransition("failed", "cancelled"));
});

test("CORE-09: stamped/confirmed/settled can be credited; credited is terminal", () => {
  assert.ok(canTransition("stamped", "credited"));
  assert.ok(canTransition("confirmed", "credited"));
  assert.ok(canTransition("settled", "credited"));
  assert.ok(isTerminal("credited"));
  assert.equal(canTransition("credited", "settled"), false);
  assert.equal(canTransition("credited", "cancelled"), false);
});

test("CORE-09: cancellation is allowed pre-submission and post-stamp, not in flight", () => {
  assert.ok(canTransition("draft", "cancelled"));
  assert.ok(canTransition("validated", "cancelled"));
  assert.ok(canTransition("stamped", "cancelled"));
  assert.ok(canTransition("confirmed", "cancelled"));
  // An invoice mid-stamping cannot be cancelled: the rail may still stamp it.
  assert.equal(canTransition("submitted", "cancelled"), false);
  // A settled invoice is corrected via credit note, never bare cancellation.
  assert.equal(canTransition("settled", "cancelled"), false);
});

test("forbidden transitions throw a 409 domain error", () => {
  assert.throws(
    () => assertTransition("cancelled", "stamped"),
    /INVALID_TRANSITION|Cannot move invoice/,
  );
  assert.throws(() => assertTransition("draft", "stamped"));
  assert.throws(() => assertTransition("stamped", "draft"));
});

test("CORE-09: cancelled and credited invoices are never presentable as eligible", () => {
  assert.equal(isPresentableAsEligible("cancelled"), false);
  assert.equal(isPresentableAsEligible("credited"), false);
  assert.ok(isPresentableAsEligible("stamped"));
  assert.ok(isPresentableAsEligible("confirmed"));
  assert.ok(isPresentableAsEligible("settled"));
});
