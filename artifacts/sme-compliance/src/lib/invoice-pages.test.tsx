// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { listInvoicesPaged, type Invoice } from "@workspace/api-client-react";
import {
  invoicePageUrl,
  useInvoicePages,
  type InvoicePageFilters,
} from "./invoice-pages";

vi.mock("@workspace/api-client-react", async (original) => ({
  ...(await original<typeof import("@workspace/api-client-react")>()),
  listInvoicesPaged: vi.fn(),
}));
const filters: InvoicePageFilters = {
  statusGroup: "all",
  fromDate: "",
  toDate: "",
  minAmount: "",
  maxAmount: "",
};
const row = (id: string) =>
  ({ id, buyerPartyId: "buyer", contentRevision: 1 }) as Invoice;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={client}>{children}</QueryClientProvider>
);
let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  vi.resetAllMocks();
});

describe("invoice cursor navigation", () => {
  test("preserves opaque cursors and all filter inputs without offsets", () => {
    const url = new URL(
      invoicePageUrl(
        "Ada & Co",
        {
          ...filters,
          statusGroup: "draft",
          fromDate: "2026-01-01",
          minAmount: "100.00",
        },
        "opaque+/=cursor",
      ),
      "https://example.test",
    );
    expect(url.pathname).toBe("/api/invoices/page");
    expect(url.searchParams.get("cursor")).toBe("opaque+/=cursor");
    expect(url.searchParams.get("q")).toBe("Ada & Co");
    expect(url.searchParams.get("statusGroup")).toBe("draft");
    expect(url.searchParams.get("minAmount")).toBe("100.00");
    expect(url.searchParams.has("offset")).toBe(false);
  });
  test("uses the returned cursor and server total, not loaded row counts", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(listInvoicesPaged).mockImplementation(async (params) => ({
      items: [row(params?.cursor ? "older" : "newer")],
      nextCursor: params?.cursor ? null : "server-cursor",
      total: 604,
    }));
    const { result } = renderHook(
      () => useInvoicePages("", filters, "firm:user:client"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loaded).toHaveLength(1));
    expect(result.current.total).toBe(604);
    expect(result.current.counts.all).toBe(604);
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.loaded).toHaveLength(2));
    expect(result.current.loaded.map((item) => item.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(result.current.hasMore).toBe(false);
    expect(
      vi
        .mocked(listInvoicesPaged)
        .mock.calls.some(([params]) => params?.cursor === "server-cursor"),
    ).toBe(true);
  });
  test("clears accumulated pages and cancels old requests on a new search/context", async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let oldSignal: AbortSignal | undefined;
    vi.mocked(listInvoicesPaged).mockImplementation(async (params, options) => {
      if (!params?.q && params?.limit === 50) {
        oldSignal = options?.signal ?? undefined;
        return new Promise(() => {});
      }
      return { items: [row(params?.q ?? "count")], nextCursor: null, total: 1 };
    });
    const { result, rerender } = renderHook(
      ({ search, scope }) => useInvoicePages(search, filters, scope),
      { initialProps: { search: "", scope: "A" }, wrapper },
    );
    await waitFor(() => expect(oldSignal).toBeDefined());
    rerender({ search: "new", scope: "A" });
    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    expect(result.current.loaded).toEqual([]);
    await waitFor(() => expect(result.current.loaded[0]?.id).toBe("new"));
    rerender({ search: "other", scope: "B" });
    expect(result.current.loaded).toEqual([]);
    await waitFor(() => expect(result.current.loaded[0]?.id).toBe("other"));
  });
});
