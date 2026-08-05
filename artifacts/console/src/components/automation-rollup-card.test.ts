import { test, expect, describe } from "vitest";
import { pausedSummary } from "./automation-rollup-card";

// The rollup card's paused-count line: reasons come from the server's
// closed pause-reason sets (both policy kinds), folded into one legible
// phrase. Snake_case reasons are display-flattened; a clean fleet renders
// nothing at all rather than "0 paused".
describe("pausedSummary", () => {
  test("no pauses means no line, not a zero", () => {
    expect(pausedSummary({})).toBeNull();
  });

  test("totals across reasons and flattens snake_case", () => {
    expect(pausedSummary({ run_halted: 2, grantor_inactive: 1 })).toBe(
      "3 paused (run halted 2, grantor inactive 1)",
    );
  });

  test("a single manual pause reads plainly", () => {
    expect(pausedSummary({ manual: 1 })).toBe("1 paused (manual 1)");
  });
});
