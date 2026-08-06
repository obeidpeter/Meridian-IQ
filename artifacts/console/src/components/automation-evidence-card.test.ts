import { test, expect, describe } from "vitest";
import type { AutomationEvidenceKind } from "@workspace/api-client-react";
import { actNowLine, evidenceLine } from "./automation-evidence-card";

// The evidence card's two phrasing helpers. Both feed a consent surface, so
// the pins are honesty pins: no rate is ever implied from an empty sample,
// the naira figure keeps its "risked" framing, and empty cohorts render
// nothing rather than "0".

function kind(over: Partial<AutomationEvidenceKind>): AutomationEvidenceKind {
  return {
    kind: "submit_overdue",
    sample: 0,
    agreed: 0,
    disagreed: 0,
    pending: 0,
    agreementRate: null,
    medianLeadDays: null,
    exposureFloorNgn: null,
    note: "n",
    ...over,
  };
}

describe("evidenceLine", () => {
  test("no decided cases → null (the card states it, never a 0% rate)", () => {
    expect(evidenceLine(kind({ pending: 4 }))).toBeNull();
  });

  test("agreement, rate and lead compose into one line", () => {
    expect(
      evidenceLine(
        kind({
          sample: 9,
          agreed: 8,
          disagreed: 1,
          agreementRate: 0.889,
          medianLeadDays: 6,
        }),
      ),
    ).toBe("8 of 9 hand decisions agreed (89%) · median 6 days earlier");
  });

  test("singulars: one decision, one day", () => {
    expect(
      evidenceLine(
        kind({
          sample: 1,
          agreed: 1,
          agreementRate: 1,
          medianLeadDays: 1,
        }),
      ),
    ).toBe("1 of 1 hand decision agreed (100%) · median 1 day earlier");
  });
});

describe("actNowLine", () => {
  test("empty cohort and no exposure → null", () => {
    expect(actNowLine(kind({}))).toBeNull();
    expect(actNowLine(kind({ exposureFloorNgn: "0" }))).toBeNull();
  });

  test("pending and the s.104 floor compose, naira grouped", () => {
    expect(
      actNowLine(kind({ pending: 3, exposureFloorNgn: "50000" })),
    ).toBe("Would act on 3 now · ₦50,000 s.104 floor risked in the window");
  });

  test("exposure alone still renders with the risked framing", () => {
    expect(actNowLine(kind({ exposureFloorNgn: "25000" }))).toBe(
      "₦25,000 s.104 floor risked in the window",
    );
  });
});
