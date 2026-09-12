// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { Route, Switch } from "wouter";
import { renderWithClient } from "../test-utils";

vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  useGetMe: () => ({
    data: { userId: "user", firmId: "firm", clientPartyId: "client" },
  }),
}));
vi.mock("@/lib/invoice-pages", () => ({
  useInvoicePages: () => ({
    loaded: [
      {
        id: "invoice-1",
        invoiceNumber: "INV-001",
        buyerLegalName: "Ada & Co",
        status: "failed",
        currency: "NGN",
        grandTotal: "500",
        issueDate: "2026-06-01",
      },
    ],
    hasLoaded: true,
    hasMore: false,
    loadingMore: false,
    initialLoading: false,
    isError: false,
    refetch: vi.fn(),
    loadMore: vi.fn(),
    resetToFirstPage: vi.fn(),
    query: "Ada & Co",
    counts: {},
    total: 1,
  }),
}));
import { Invoices } from "./invoices";
import { BackToVault } from "./invoice-detail/page-states";

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("scrollY", 975);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("row navigation and Back to vault restore filters, expanded inputs and list scroll", async () => {
  const query =
    "q=Ada+%26+Co&filter=failed&fromDate=2026-01-01&toDate=2026-09-01&minAmount=100&maxAmount=1000&advanced=1";
  window.history.replaceState(null, "", `/invoices?${query}`);
  renderWithClient(
    <Switch>
      <Route path="/invoices">
        <Invoices />
      </Route>
      <Route path="/invoices/:id">
        <BackToVault />
      </Route>
    </Switch>,
  );
  fireEvent.click(screen.getByRole("link", { name: /INV-001/ }));
  const back = await screen.findByRole("link", { name: "Back to vault" });
  expect(back.getAttribute("href")).toBe(`/invoices?${query}`);
  fireEvent.click(back);
  expect(
    ((await screen.findByLabelText("Search invoices")) as HTMLInputElement)
      .value,
  ).toBe("Ada & Co");
  expect((screen.getByLabelText("Issued from") as HTMLInputElement).value).toBe(
    "2026-01-01",
  );
  expect((screen.getByLabelText("Issued to") as HTMLInputElement).value).toBe(
    "2026-09-01",
  );
  expect(
    (screen.getByLabelText("Min amount (₦)") as HTMLInputElement).value,
  ).toBe("100");
  expect(
    (screen.getByLabelText("Max amount (₦)") as HTMLInputElement).value,
  ).toBe("1000");
  expect(
    screen.getByTestId("filter-invoices-failed").getAttribute("aria-pressed"),
  ).toBe("true");
  await waitFor(() =>
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 975,
      left: 0,
      behavior: "auto",
    }),
  );
});
