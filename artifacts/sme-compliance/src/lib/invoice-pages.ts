import { useEffect, useState } from "react";
import {
  getListInvoicesQueryKey,
  getListInvoicesPagedUrl,
  listInvoicesPaged,
  type ListInvoicesPaged200,
} from "@workspace/api-client-react";
import {
  useInfiniteQuery,
  useQueries,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";

export const INVOICE_GROUPS = [
  "all",
  "draft",
  "pending",
  "stamped",
  "settled",
  "failed",
  "closed",
] as const;
export type InvoiceGroup = (typeof INVOICE_GROUPS)[number];
export interface InvoicePageFilters {
  statusGroup: InvoiceGroup;
  fromDate: string;
  toDate: string;
  minAmount: string;
  maxAmount: string;
}
export type InvoicePage = Omit<ListInvoicesPaged200, "items"> & {
  items: (ListInvoicesPaged200["items"][number] & {
    buyerLegalName?: string;
  })[];
};

export function invoicePageUrl(
  q: string,
  filters: InvoicePageFilters,
  cursor: string | null,
  limit = 50,
) {
  return getListInvoicesPagedUrl(invoicePageParams(q, filters, cursor, limit));
}

function invoicePageParams(
  q: string,
  filters: InvoicePageFilters,
  cursor: string | null,
  limit = 50,
) {
  return {
    q: q || undefined,
    cursor: cursor ?? undefined,
    limit,
    statusGroup:
      filters.statusGroup === "all" ? undefined : filters.statusGroup,
    fromDate: filters.fromDate || undefined,
    toDate: filters.toDate || undefined,
    minAmount: filters.minAmount || undefined,
    maxAmount: filters.maxAmount || undefined,
  };
}

export function useInvoicePages(
  search: string,
  filters: InvoicePageFilters,
  scope: string,
) {
  const client = useQueryClient();
  const [q, setQ] = useState(search.trim());
  const waiting = q !== search.trim();
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const queryKey = [
    ...getListInvoicesQueryKey(),
    "cursor",
    scope,
    q,
    filterKey,
  ];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }): Promise<InvoicePage> =>
      listInvoicesPaged(invoicePageParams(q, filters, pageParam), { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!scope && !waiting,
  });
  useEffect(() => {
    if (waiting)
      void client.cancelQueries({
        queryKey: [...getListInvoicesQueryKey(), "cursor", scope, q],
      });
  }, [waiting, scope, q, client]);
  const countQueries = useQueries({
    queries: INVOICE_GROUPS.map((statusGroup) => ({
      queryKey: [
        ...getListInvoicesQueryKey(),
        "count",
        scope,
        q,
        JSON.stringify({ ...filters, statusGroup }),
      ],
      queryFn: ({ signal }: { signal: AbortSignal }): Promise<InvoicePage> =>
        listInvoicesPaged(
          invoicePageParams(q, { ...filters, statusGroup }, null, 1),
          { signal },
        ),
      enabled: !!scope && !waiting,
      staleTime: 30_000,
    })),
  });
  const counts = Object.fromEntries(
    INVOICE_GROUPS.map((key, index) => [
      key,
      waiting ? undefined : countQueries[index].data?.total,
    ]),
  ) as Record<InvoiceGroup, number | undefined>;
  const loaded = waiting
    ? []
    : (query.data?.pages.flatMap((page) => page.items) ?? []);
  const resetToFirstPage = () => {
    void client.cancelQueries({ queryKey }).then(() => {
      client.setQueryData<InfiniteData<InvoicePage, string | null>>(
        queryKey,
        (data) =>
          data
            ? {
                pages: data.pages.slice(0, 1),
                pageParams: data.pageParams.slice(0, 1),
              }
            : data,
      );
      return client.invalidateQueries({ queryKey });
    });
  };
  return {
    loaded,
    counts,
    total: waiting ? undefined : query.data?.pages[0]?.total,
    hasLoaded: !waiting && !!query.data,
    hasMore: !waiting && query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    initialLoading: waiting || query.isPending,
    isError: query.isError,
    refetch: () =>
      query.isFetchNextPageError ? query.fetchNextPage() : query.refetch(),
    loadMore: () => {
      if (!query.isFetching && query.hasNextPage) void query.fetchNextPage();
    },
    resetToFirstPage,
    query: q,
  };
}
