import { test, expect, describe } from "vitest";
import type { ClerkAnswer } from "@workspace/api-client-react";
import { heldAnswer } from "./clerk-ask";

// Multi-turn Ask holds the last rendered answer in component state because
// TanStack v5 resets mutation.data the moment the next mutate() starts — the
// answer being followed up on must stay readable while (and after) the
// follow-up runs. heldAnswer is that state's reducer.

const answer = (over: Partial<ClerkAnswer>): ClerkAnswer => ({
  answered: true,
  proposition: "VAT is 7.5% on standard-rated supplies.",
  citation: "VAT Act s.4",
  claimKey: "vat.standard-rate",
  claimVersion: 3,
  ...over,
});

describe("heldAnswer", () => {
  test("a successful ask replaces the held answer", () => {
    const first = answer({});
    const second = answer({ proposition: "₦1.2m is overdue.", dataIntent: "overdue" });
    expect(heldAnswer(null, { type: "success", answer: first })).toBe(first);
    expect(heldAnswer(first, { type: "success", answer: second })).toBe(second);
  });

  test("a refusal is still the newest answer — it replaces too", () => {
    const prev = answer({});
    const refusal = answer({
      answered: false,
      refusalReason: "No active claim covers this.",
    });
    expect(heldAnswer(prev, { type: "success", answer: refusal })).toBe(refusal);
  });

  test("a failed follow-up keeps the previous answer on screen", () => {
    const prev = answer({});
    expect(heldAnswer(prev, { type: "error" })).toBe(prev);
    // …and an error before any answer holds nothing, not a phantom.
    expect(heldAnswer(null, { type: "error" })).toBeNull();
  });

  test("a success with no answer payload clears to null rather than showing a stale answer", () => {
    const prev = answer({});
    expect(heldAnswer(prev, { type: "success", answer: undefined })).toBeNull();
    expect(heldAnswer(prev, { type: "success", answer: null })).toBeNull();
  });
});
