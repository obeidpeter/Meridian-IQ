import { test, expect, describe } from "vitest";
import {
  PORTFOLIO_GROUPS,
  calendarHasContent,
  rejectionsHaveContent,
  visiblePortfolioGroups,
} from "./portfolio";

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

// A section composed entirely of self-gating cards must not render a bare
// heading + dead anchor chip when every member gates itself to null. The
// group filter drives BOTH the anchor row and the section rendering, so a
// chip can never point at a section that isn't there.
describe("visiblePortfolioGroups", () => {
  test("clients and money always render; the self-gating pair follows its flags", () => {
    expect(
      visiblePortfolioGroups({ compliance: true, connections: true }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "compliance", "connections"]);
    expect(
      visiblePortfolioGroups({ compliance: false, connections: false }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money"]);
  });

  test("each flag drops exactly its own group, order preserved", () => {
    expect(
      visiblePortfolioGroups({ compliance: false, connections: true }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "connections"]);
    expect(
      visiblePortfolioGroups({ compliance: true, connections: false }).map(
        (g) => g.id,
      ),
    ).toEqual(["clients", "money", "compliance"]);
  });
});

describe("card-content predicates (shared by card gate and section occupancy)", () => {
  test("calendarHasContent mirrors the calendar card's quiet-month gate", () => {
    expect(calendarHasContent(undefined)).toBe(false);
    expect(calendarHasContent({ days: [], overdue: { invoices: 0 } })).toBe(
      false,
    );
    expect(calendarHasContent({ days: [{}], overdue: { invoices: 0 } })).toBe(
      true,
    );
    expect(calendarHasContent({ days: [], overdue: { invoices: 2 } })).toBe(
      true,
    );
  });

  test("rejectionsHaveContent mirrors the rejection card's quiet-firm gate", () => {
    expect(rejectionsHaveContent(undefined)).toBe(false);
    expect(rejectionsHaveContent({ rows: [] })).toBe(false);
    expect(rejectionsHaveContent({ rows: [{}] })).toBe(true);
  });
});
