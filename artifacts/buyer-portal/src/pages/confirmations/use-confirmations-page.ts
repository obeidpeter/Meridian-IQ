import { useDeferredValue, useMemo, useState } from "react";
import {
  useListBuyerInvoices,
  useGetBuyerInvoiceSummary,
} from "@workspace/api-client-react";
import { usePageTitle } from "@/hooks/use-page-title";
import { useUrlTab } from "@workspace/web-ui";
import {
  FILTER_KEYS,
  PAGE_SIZE,
  SERVER_PAGE_SIZE,
  type FilterKey,
} from "./constants";
import { queueCounts } from "./helpers";
import { useBulkConfirm } from "./use-bulk-confirm";

// The queue slice of the page's state: the URL-bound filter, the search,
// the two-level paging over the server window, and the counts.
function useInvoiceQueue() {
  const [filter, setFilter] = useUrlTab<FilterKey>(
    "status",
    "all",
    FILTER_KEYS,
  );
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [serverPage, setServerPage] = useState(0);
  const deferredSearch = useDeferredValue(search.trim());
  const { data, isLoading, isFetching, error, refetch } = useListBuyerInvoices({
    limit: SERVER_PAGE_SIZE + 1,
    offset: serverPage * SERVER_PAGE_SIZE,
    ...(filter === "all" ? {} : { confirmationState: filter }),
    ...(deferredSearch === "" ? {} : { search: deferredSearch }),
  });
  const { data: summary } = useGetBuyerInvoiceSummary();

  const invoices = useMemo(
    () => (data ?? []).slice(0, SERVER_PAGE_SIZE),
    [data],
  );
  const hasNextServerPage = (data?.length ?? 0) > SERVER_PAGE_SIZE;

  const filtered = invoices;
  const query = deferredSearch;

  const { awaitingCount, awaitingTotal, counts } = queueCounts(
    summary,
    invoices,
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const hasPreviousPage = serverPage > 0 || currentPage > 1;
  const hasNextPage = currentPage < pageCount || hasNextServerPage;
  const displayPage = serverPage * (SERVER_PAGE_SIZE / PAGE_SIZE) + currentPage;
  const visibleStart =
    serverPage * SERVER_PAGE_SIZE + (currentPage - 1) * PAGE_SIZE + 1;
  const visibleEnd = visibleStart + visible.length - 1;

  const goToPreviousPage = () => {
    if (currentPage > 1) {
      setPage(currentPage - 1);
      return;
    }
    if (serverPage > 0) {
      setServerPage(serverPage - 1);
      setPage(SERVER_PAGE_SIZE / PAGE_SIZE);
    }
  };

  const goToNextPage = () => {
    if (currentPage < pageCount) {
      setPage(currentPage + 1);
      return;
    }
    if (hasNextServerPage) {
      setServerPage(serverPage + 1);
      setPage(1);
    }
  };

  const isFirstRun = (summary?.total ?? invoices.length) === 0;
  const hasActiveNarrowing = filter !== "all" || query !== "";

  return {
    filter,
    setFilter,
    search,
    setSearch,
    setPage,
    serverPage,
    setServerPage,
    deferredSearch,
    data,
    isLoading,
    isFetching,
    error,
    refetch,
    summary,
    invoices,
    hasNextServerPage,
    filtered,
    query,
    awaitingCount,
    awaitingTotal,
    counts,
    pageCount,
    currentPage,
    visible,
    hasPreviousPage,
    hasNextPage,
    displayPage,
    visibleStart,
    visibleEnd,
    goToPreviousPage,
    goToNextPage,
    isFirstRun,
    hasActiveNarrowing,
  };
}

// The whole page's state in one bag (R126). The queue and bulk slices are
// spread together: keep their key sets disjoint, or a later key silently
// shadows an earlier one — TypeScript will not flag the collision.
export function useConfirmationsPage() {
  usePageTitle("Confirmations");
  const queue = useInvoiceQueue();
  const bulkConfirm = useBulkConfirm(queue);
  return { ...queue, ...bulkConfirm };
}

export type ConfirmationsPageState = ReturnType<typeof useConfirmationsPage>;
