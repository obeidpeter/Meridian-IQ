// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  invoiceListUrl,
  invoiceReturnUrl,
  invoiceWorkspaceHref,
  readInvoiceListPosition,
  saveInvoiceListPosition,
  useInvoiceListReturn,
} from "./invoice-list-navigation";

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal("scrollY", 840);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("round-trips all list filters and expanded controls through a safe detail URL", () => {
  const url = invoiceListUrl(
    "?q=Ada+%26+Co&filter=stamped&fromDate=2026-01-01&toDate=2026-09-01&minAmount=12.50&maxAmount=10000&advanced=1",
  );
  const detail = new URL(
    invoiceWorkspaceHref("id/with spaces", url),
    "https://valo.test",
  );
  expect(detail.pathname).toBe("/invoices/id%2Fwith%20spaces");
  expect(invoiceReturnUrl(detail.search)).toBe(url);
});

test.each([
  "https://evil.test",
  "//evil.test",
  "/invoices/other",
  "/invoices/../admin",
  "/invoices\\evil",
  "javascript:alert(1)",
])("rejects unrelated return target %s", (returnTo) => {
  expect(invoiceReturnUrl(new URLSearchParams({ returnTo }).toString())).toBe(
    "/invoices",
  );
});

test("stores navigation metadata only, isolated by principal/client and filter URL", () => {
  saveInvoiceListPosition("firm:user:client", "/invoices?q=Acme", 100);
  expect(
    readInvoiceListPosition("firm:user:client", "/invoices?q=Acme"),
  ).toMatchObject({ top: 840, count: 100 });
  expect(
    readInvoiceListPosition("firm:other:client", "/invoices?q=Acme"),
  ).toBeNull();
  expect(readInvoiceListPosition("firm:user:client", "/invoices")).toBeNull();
  expect(
    Object.keys(
      JSON.parse(sessionStorage.getItem(sessionStorage.key(0)!)!),
    ).sort(),
  ).toEqual(["count", "savedAt", "top", "url"]);
});

test("expired, corrupt and blocked storage do not break navigation", () => {
  saveInvoiceListPosition("scope", "/invoices", 50);
  const key = sessionStorage.key(0)!;
  const value = JSON.parse(sessionStorage.getItem(key)!);
  sessionStorage.setItem(
    key,
    JSON.stringify({ ...value, savedAt: Date.now() - 31 * 60_000 }),
  );
  expect(readInvoiceListPosition("scope", "/invoices")).toBeNull();
  sessionStorage.setItem(key, "invalid");
  expect(readInvoiceListPosition("scope", "/invoices")).toBeNull();
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => saveInvoiceListPosition("scope", "/invoices", 50)).not.toThrow();
});

const base = {
  scope: "scope",
  url: "/invoices",
  count: 0,
  ready: false,
  hasMore: true,
  loadingMore: false,
  isError: false,
};
test("waits for saved pages, then restores scroll after the route layout reset", async () => {
  saveInvoiceListPosition("scope", "/invoices", 100);
  const loadMore = vi.fn();
  const { rerender } = renderHook(
    (props) => useInvoiceListReturn({ ...props, loadMore }),
    { initialProps: base },
  );
  expect(loadMore).not.toHaveBeenCalled();
  rerender({ ...base, ready: true, count: 50 });
  expect(loadMore).toHaveBeenCalledOnce();
  expect(window.scrollTo).not.toHaveBeenCalled();
  rerender({ ...base, ready: true, count: 50, loadingMore: true });
  expect(window.scrollTo).not.toHaveBeenCalled();
  rerender({ ...base, ready: true, count: 100 });
  await waitFor(() =>
    expect(window.scrollTo).toHaveBeenCalledWith({
      top: 840,
      left: 0,
      behavior: "auto",
    }),
  );
});

test("does not load more on errors, and resumes when the user retries", async () => {
  saveInvoiceListPosition("scope", "/invoices", 100);
  const loadMore = vi.fn();
  const { rerender } = renderHook(
    (props) => useInvoiceListReturn({ ...props, loadMore }),
    { initialProps: { ...base, isError: true, ready: true } },
  );
  expect(loadMore).not.toHaveBeenCalled();
  rerender({ ...base, isError: false, ready: true, hasMore: false });
  await waitFor(() => expect(window.scrollTo).toHaveBeenCalled());
});

test("user interaction cancels delayed restoration; a different search never inherits it", async () => {
  saveInvoiceListPosition("scope", "/invoices", 100);
  const loadMore = vi.fn();
  const { rerender } = renderHook(
    (props) => useInvoiceListReturn({ ...props, loadMore }),
    { initialProps: base },
  );
  act(() => {
    window.dispatchEvent(new Event("wheel"));
  });
  rerender({ ...base, ready: true, count: 100 });
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(window.scrollTo).not.toHaveBeenCalled();
  rerender({ ...base, url: "/invoices?q=other", ready: true, count: 100 });
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(loadMore).not.toHaveBeenCalled();
});
