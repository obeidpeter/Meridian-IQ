import { useEffect, useState } from "react";

const FILTER_PARAMS = [
  "q",
  "filter",
  "fromDate",
  "toDate",
  "minAmount",
  "maxAmount",
  "advanced",
];

export function invoiceListUrl(search: string): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of FILTER_PARAMS) {
    const value = source.get(key);
    if (value) params.set(key, value);
  }
  return `/invoices${params.size ? `?${params}` : ""}`;
}

export function invoiceWorkspaceHref(id: string, returnTo: string): string {
  return `/invoices/${encodeURIComponent(id)}?${new URLSearchParams({ returnTo })}`;
}

export function invoiceReturnUrl(search: string): string {
  return invoiceReturnTarget(new URLSearchParams(search).get("returnTo"));
}

export function invoiceReturnTarget(candidate: string | null): string {
  if (
    !candidate ||
    (candidate !== "/invoices" && !candidate.startsWith("/invoices?"))
  )
    return "/invoices";
  return invoiceListUrl(candidate.slice("/invoices".length));
}

type ListPosition = {
  url: string;
  top: number;
  count: number;
  savedAt: number;
};
const storageKey = (scope: string) => `valo:invoice-list-position:${scope}`;

// Only navigation metadata is stored, never invoice/customer records or pages.
export function saveInvoiceListPosition(
  scope: string,
  url: string,
  count: number,
) {
  if (!scope) return;
  try {
    sessionStorage.setItem(
      storageKey(scope),
      JSON.stringify({ url, count, top: window.scrollY, savedAt: Date.now() }),
    );
  } catch {
    /* Navigation must work when storage is unavailable. */
  }
}

export function readInvoiceListPosition(
  scope: string,
  url: string,
): ListPosition | null {
  if (!scope) return null;
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(storageKey(scope)) ?? "null",
    );
    if (!value || typeof value !== "object") return null;
    const position = value as Partial<ListPosition>;
    if (
      position.url !== url ||
      typeof position.top !== "number" ||
      !Number.isFinite(position.top) ||
      position.top < 0 ||
      typeof position.count !== "number" ||
      !Number.isInteger(position.count) ||
      position.count < 0 ||
      typeof position.savedAt !== "number" ||
      Date.now() - position.savedAt > 30 * 60_000
    )
      return null;
    return position as ListPosition;
  } catch {
    return null;
  }
}

export function useInvoiceListReturn({
  scope,
  url,
  count,
  ready,
  hasMore,
  loadingMore,
  isError,
  loadMore,
}: {
  scope: string;
  url: string;
  count: number;
  ready: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  isError: boolean;
  loadMore: () => void;
}) {
  const [position, setPosition] = useState<ListPosition | null>(null);
  useEffect(() => {
    setPosition(readInvoiceListPosition(scope, url));
  }, [scope, url]);
  useEffect(() => {
    const cancel = () => setPosition(null);
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    events.forEach((event) =>
      window.addEventListener(event, cancel, { passive: true }),
    );
    return () =>
      events.forEach((event) => window.removeEventListener(event, cancel));
  }, []);
  useEffect(() => {
    if (!position || position.url !== url || !ready || loadingMore || isError)
      return;
    if (count < position.count && hasMore) {
      loadMore();
      return;
    }
    // Runs after the layout's route-change scroll reset and after rows render.
    const frame = requestAnimationFrame(() => {
      window.scrollTo({ top: position.top, left: 0, behavior: "auto" });
      setPosition(null);
    });
    return () => cancelAnimationFrame(frame);
  }, [position, url, count, ready, hasMore, loadingMore, isError, loadMore]);
  return () => saveInvoiceListPosition(scope, url, count);
}
