// @vitest-environment jsdom
// The vault's status tabs: tone-grouped so every contract status is reachable
// from exactly one non-All tab (settled, credited and cancelled invoices used
// to be findable only under All), with the tab words mirroring the row badges.
import { describe, expect, test } from "vitest";
import type { Invoice } from "@workspace/api-client-react";
import {
  FILTERS,
  matchesFilter,
  nairaApproxLine,
  nairaEquivalent,
} from "./invoices";

const inv = (status: string) => ({ status }) as Invoice;

describe("vault filter tabs", () => {
  test("the label vocabulary mirrors the badge words", () => {
    expect(FILTERS.map((f) => f.label)).toEqual([
      "All",
      "Drafts",
      "Pending stamp",
      "Stamped",
      "Settled",
      "Failed",
      "Closed",
    ]);
  });

  test("every contract status belongs to exactly one non-All tab", () => {
    const home: Record<string, string> = {
      draft: "draft",
      validated: "draft",
      submitted: "pending",
      stamped: "stamped",
      confirmed: "stamped",
      settled: "settled",
      credited: "closed",
      cancelled: "closed",
      failed: "failed",
    };
    for (const [status, homeKey] of Object.entries(home)) {
      expect(matchesFilter(inv(status), "all")).toBe(true);
      for (const f of FILTERS) {
        if (f.key === "all") continue;
        expect(matchesFilter(inv(status), f.key)).toBe(f.key === homeKey);
      }
    }
  });

  test("an off-contract status matches only All", () => {
    expect(matchesFilter(inv("weird"), "all")).toBe(true);
    for (const f of FILTERS) {
      if (f.key === "all") continue;
      expect(matchesFilter(inv("weird"), f.key)).toBe(false);
    }
  });
});

// A foreign amount never appears without its naira value when the captured
// rate makes one computable — and a rate is never assumed (Dix's
// substitutivity: the filter maths and the visible line share one function).
describe("naira equivalents", () => {
  const fx = (over: Partial<Invoice>) =>
    ({
      currency: "USD",
      grandTotal: "1500.00",
      fxRateToNgn: "1500",
      ...over,
    }) as Invoice;

  test("converts a foreign amount through the captured rate", () => {
    expect(nairaEquivalent(fx({}))).toBe(2_250_000);
    expect(nairaApproxLine(fx({}))).toBe("≈ ₦2,250,000.00");
  });

  test("an NGN invoice needs no equivalent line", () => {
    expect(
      nairaApproxLine(fx({ currency: "NGN", fxRateToNgn: null })),
    ).toBeNull();
    expect(nairaEquivalent(fx({ currency: "NGN" }))).toBe(1500);
  });

  test("a missing, zero or malformed rate yields no line — never a guess", () => {
    for (const rate of [null, "", "0", "-2", "abc"]) {
      expect(nairaApproxLine(fx({ fxRateToNgn: rate as never }))).toBeNull();
      expect(nairaEquivalent(fx({ fxRateToNgn: rate as never }))).toBeNull();
    }
  });
});
