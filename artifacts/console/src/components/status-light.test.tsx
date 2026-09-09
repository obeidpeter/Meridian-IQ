// @vitest-environment jsdom
// The deterministic invoice status light. The pins:
//  - No data (still loading, or the endpoint dark) renders no button at all
//    — an inert dot promises nothing it cannot show.
//  - The default trigger stays the quiet dot with a status aria-label.
//  - showWhy (failing rows in client-detail) adds a VISIBLE "Why?" beside
//    the dot and prefixes the accessible name with the same word
//    (label-in-name), so the server's reasons + recommended action are one
//    obvious click away.
//  - Clicking the trigger opens the popover carrying the server's reasons
//    and recommendedAction verbatim.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// Radix's popper positioning needs a ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

const harness = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  reset() {
    this.data = {
      light: "red",
      reasons: ["Submission failed twice"],
      recommendedAction: "Fix the buyer TIN and resubmit.",
    };
    this.isLoading = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetInvoiceStatusLight: () => ({
      data: harness.data,
      isLoading: harness.isLoading,
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-in.
import { InvoiceStatusLight } from "./status-light";

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("InvoiceStatusLight", () => {
  test("no data renders no button at all", () => {
    harness.isLoading = true;
    harness.data = undefined;
    render(<InvoiceStatusLight invoiceId="inv-1" />);
    expect(screen.queryByTestId("status-light-inv-1")).toBeNull();
  });

  test("default trigger: quiet dot, status name, no visible Why?", () => {
    render(<InvoiceStatusLight invoiceId="inv-1" />);
    const button = screen.getByTestId("status-light-inv-1");
    expect(button.getAttribute("aria-label")).toBe("Status: Action required");
    expect(button.textContent).not.toContain("Why?");
  });

  test("showWhy: visible Why? and the accessible name leads with it", () => {
    render(<InvoiceStatusLight invoiceId="inv-1" showWhy />);
    const button = screen.getByTestId("status-light-inv-1");
    expect(button.textContent).toContain("Why?");
    expect(button.getAttribute("aria-label")).toBe(
      "Why? — status: Action required",
    );
  });

  test("clicking the trigger opens the reasons + recommended action", async () => {
    render(<InvoiceStatusLight invoiceId="inv-1" showWhy />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("status-light-inv-1"));
    });
    expect(screen.getByText("Submission failed twice")).toBeTruthy();
    expect(screen.getByText("Fix the buyer TIN and resubmit.")).toBeTruthy();
  });
});
