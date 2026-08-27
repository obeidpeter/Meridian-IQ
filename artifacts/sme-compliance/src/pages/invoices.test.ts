// @vitest-environment jsdom
// The vault's status tabs: tone-grouped so every contract status is reachable
// from exactly one non-All tab (settled, credited and cancelled invoices used
// to be findable only under All), with the tab words mirroring the row badges.
import { describe, expect, test } from "vitest";
import type { Invoice } from "@workspace/api-client-react";
import { FILTERS, matchesFilter } from "./invoices";

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
