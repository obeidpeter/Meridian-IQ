import type { FakeRail } from "../rails/fake-rail";
import type { RailFault } from "../rails/faults";

// The rail soak's scenario catalogue (R126, split from soak.ts as the leaf
// both the drive and the verify phases read): the seeded PRNG, the fault
// mix and the per-invoice scripting of the two fake rails. Behaviour and
// the seeded sequence are untouched — the same seed scripts the same faults.

export type SoakScenario =
  | "accept"
  | "reject"
  | "primary_unavailable"
  | "primary_timeout"
  | "rate_limited"
  | "duplicate_recovered"
  | "malformed_then_recovered"
  | "lookup_error_then_recovered"
  | "primary_unauthorized";

// mulberry32: a tiny seeded PRNG so a soak is repeatable.
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The fault mix. Weights are relative; the scenario names double as the
// expectation each invoice is checked against.
export const MIX: Array<[SoakScenario, number]> = [
  ["accept", 60],
  ["reject", 6],
  ["primary_unavailable", 8],
  ["primary_timeout", 5],
  ["rate_limited", 5],
  ["duplicate_recovered", 5],
  ["malformed_then_recovered", 4],
  ["lookup_error_then_recovered", 4],
  ["primary_unauthorized", 3],
];

export function pickScenario(random: () => number): SoakScenario {
  const total = MIX.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [scenario, weight] of MIX) {
    roll -= weight;
    if (roll < 0) return scenario;
  }
  return "accept";
}

export function scriptScenario(
  scenario: SoakScenario,
  invoiceNumber: string,
  primary: FakeRail,
  secondary: FakeRail,
): void {
  const on = (rail: FakeRail, fault: RailFault) =>
    rail.script(invoiceNumber, fault);
  switch (scenario) {
    case "accept":
      return;
    case "reject":
      on(primary, { outcome: "reject", code: "MBS_INVALID_TIN" });
      on(secondary, { outcome: "reject", code: "MBS_INVALID_TIN" });
      return;
    case "primary_unavailable":
      on(primary, { outcome: "unavailable", times: 1 });
      return;
    case "primary_timeout":
      on(primary, { outcome: "timeout", times: 1 });
      return;
    case "rate_limited":
      on(primary, { outcome: "rate_limit", times: 1, retryAfterSeconds: 1 });
      on(secondary, { outcome: "rate_limit", times: 1, retryAfterSeconds: 1 });
      return;
    case "duplicate_recovered":
      on(primary, { outcome: "duplicate", holdsStamp: true });
      return;
    case "malformed_then_recovered":
      // A garbled 2xx from a rail that DID stamp: the same try fails over
      // to the secondary, which may stamp it too, or a retry meets 409 on
      // the primary and recovers — either way exactly one stamp is recorded.
      on(primary, { outcome: "malformed", holdsStamp: true, times: 1 });
      on(secondary, { outcome: "unavailable", times: 1 });
      return;
    case "lookup_error_then_recovered":
      on(primary, { outcome: "duplicate", holdsStamp: true });
      on(primary, { outcome: "unavailable", op: "lookup", times: 1 });
      on(secondary, { outcome: "unavailable", op: "lookup", times: 1 });
      return;
    case "primary_unauthorized":
      on(primary, { outcome: "unauthorized", times: 1 });
      return;
  }
}
