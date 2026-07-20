import { test, expect, describe } from "vitest";
import { PORTFOLIO_GROUPS } from "./portfolio";

// The portfolio's card groups are layout only — every card keeps its own
// gating and testids — but the grouping itself is contract: ids feed both
// the anchor row's hrefs and the section testids, so they must stay unique
// and anchor-safe.
describe("PORTFOLIO_GROUPS", () => {
  test("the four groups render in scanning order", () => {
    expect(PORTFOLIO_GROUPS.map((g) => g.id)).toEqual([
      "clients",
      "money",
      "compliance",
      "connections",
    ]);
  });

  test("ids are unique, anchor-safe and every group carries a label", () => {
    const ids = PORTFOLIO_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of PORTFOLIO_GROUPS) {
      // Anchor hrefs are `#${id}` — keep ids URL-fragment safe.
      expect(g.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(g.label.length).toBeGreaterThan(0);
    }
  });
});
