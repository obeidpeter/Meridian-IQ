// @vitest-environment jsdom
// The focusable horizontal-scroll wrapper for wide tables (the buyer
// portal's suppliers/scoreboard pattern brought console-side). The pins:
// the wrapper is a named region, keyboard-reachable (tabIndex 0), its
// accessible name appends ", scrollable", and it forwards an id only when
// other markup targets it via aria-controls.
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ScrollRegion } from "./scroll-region";

afterEach(cleanup);

describe("ScrollRegion", () => {
  test("a named, keyboard-focusable region wrapping its children", () => {
    render(
      <ScrollRegion label="Client book table">
        <table data-testid="inner-table" />
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", {
      name: "Client book table, scrollable",
    });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.className).toContain("overflow-x-auto");
    // The children mount inside the scroll container.
    expect(region.contains(screen.getByTestId("inner-table"))).toBe(true);
    // No id unless a caller passes one for aria-controls targeting.
    expect(region.hasAttribute("id")).toBe(false);
  });

  test("forwards an id when passed (aria-controls targets)", () => {
    render(
      <ScrollRegion label="Evaluation corpus table" id="table-eval-corpus-region">
        <table />
      </ScrollRegion>,
    );
    const region = screen.getByRole("region", {
      name: "Evaluation corpus table, scrollable",
    });
    expect(region.getAttribute("id")).toBe("table-eval-corpus-region");
  });
});
