// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ReadinessList,
  readinessSummary,
  type ReadinessStep,
} from "./readiness";

const STEPS: ReadinessStep[] = [
  { id: "number", label: "Invoice number", state: "done", href: "#details" },
  {
    id: "customer",
    label: "Customer selected",
    state: "todo",
    href: "#details",
  },
  {
    id: "tin",
    label: "Customer has a TIN",
    state: "attention",
    detail: "FIRS rejects B2B paper without one.",
  },
];

afterEach(cleanup);

describe("ReadinessList", () => {
  test("sums progress and exposes it as a progressbar", () => {
    render(<ReadinessList steps={STEPS} />);
    expect(screen.getByTestId("text-readiness-summary").textContent).toBe(
      "1 of 3 ready",
    );
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("33");
    expect(readinessSummary([])).toBe("0 of 0 ready");
  });

  test("each step carries its state, an anchor when given, and a screen-reader suffix", () => {
    render(<ReadinessList steps={STEPS} />);
    const number = screen.getByText("Invoice number");
    expect(number.tagName).toBe("A");
    expect(number.getAttribute("href")).toBe("#details");
    expect(number.textContent).toContain("complete");
    expect(
      screen.getByTestId("readiness-customer").getAttribute("data-state"),
    ).toBe("todo");
    const tin = screen.getByText("Customer has a TIN");
    expect(tin.tagName).toBe("SPAN");
    expect(tin.textContent).toContain("needs attention");
    expect(
      screen.getByText("FIRS rejects B2B paper without one."),
    ).toBeTruthy();
  });
});
