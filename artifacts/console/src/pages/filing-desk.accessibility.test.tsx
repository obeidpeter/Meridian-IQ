// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FilingMatrix } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  query: {
    data: undefined as FilingMatrix | undefined,
    isLoading: false,
    isError: false,
    isSuccess: false,
    refetch: vi.fn(),
  },
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return { ...actual, useGetFilingMatrix: () => harness.query };
});
import { FilingDesk } from "./filing-desk";

beforeEach(() => {
  Object.assign(harness.query, {
    data: undefined,
    isLoading: false,
    isError: false,
    isSuccess: false,
  });
  harness.query.refetch.mockClear();
});
afterEach(cleanup);

test("loading retains the Filing desk H1 without presenting stale financial totals", () => {
  harness.query.isLoading = true;
  render(<FilingDesk />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Filing desk" }),
  ).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Filing summary" })).toBeNull();
});

test("failed matrix retains the heading and an operational retry", () => {
  harness.query.isError = true;
  render(<FilingDesk />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Filing desk" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(harness.query.refetch).toHaveBeenCalledTimes(1);
});

test("an empty successful matrix retains the heading and honest zero totals", () => {
  harness.query.isSuccess = true;
  harness.query.data = {
    period: "2026-08",
    periodLabel: "August 2026",
    dueDates: { vat: "2099-09-21", paye: "2099-09-10", wht: "2099-09-21" },
    rows: [],
    totals: { clients: 0, filed: 0, unfiled: 0, overdue: 0 },
  };
  render(<FilingDesk />);
  expect(
    screen.getByRole("heading", { level: 1, name: "Filing desk" }),
  ).toBeTruthy();
  expect(screen.getByText("Every return is prepared or filed")).toBeTruthy();
  expect(screen.queryByTestId("card-filing-matrix")).toBeNull();
});
