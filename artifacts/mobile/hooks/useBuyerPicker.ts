import { getParty, listParties } from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BUYER_PAGE_SIZE,
  BUYER_SEARCH_DELAY,
  buyerPageView,
  buyerScopeKey,
  buyerSearchKey,
  buyerSearchParams,
  buyerSelectionView,
  readAuthorizedBuyer,
  readBuyerPage,
  selectedBuyerKey,
  type BuyerScope,
} from "@/lib/buyer-picker";
import { getAuthGeneration } from "@/lib/query";

export function useBuyerPicker(
  scope: BuyerScope,
  selectedId: string | null,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const [search, setSearchValue] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const scopeKey = buyerScopeKey(scope);
  const currentRef = useRef({ scope, enabled });
  currentRef.current = { scope, enabled };
  const active = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const current = useCallback(() => {
    const value = currentRef.current;
    return active.current &&
      value.enabled &&
      value.scope.generation === getAuthGeneration()
      ? value.scope
      : null;
  }, []);
  const isCurrent = useCallback(() => {
    const value = current();
    return value !== null && buyerScopeKey(value) === scopeKey;
  }, [current, scopeKey]);

  useEffect(() => {
    active.current = true;
    const pending = controllers.current;
    return () => {
      active.current = false;
      for (const controller of pending) controller.abort();
      pending.clear();
    };
  }, [scopeKey]);

  const normalizedSearch = search.trim().slice(0, 120);
  const debouncing = normalizedSearch !== settledSearch;
  useEffect(() => {
    const timer = setTimeout(
      () => setSettledSearch(normalizedSearch),
      BUYER_SEARCH_DELAY,
    );
    return () => clearTimeout(timer);
  }, [normalizedSearch]);
  const params = useMemo(
    () => buyerSearchParams(settledSearch, offset),
    [settledSearch, offset],
  );
  const pageKey = buyerSearchKey(scope, params);
  const page = useQuery({
    queryKey: pageKey,
    queryFn: ({ signal }) =>
      readBuyerPage(scope, params, listParties, current, signal),
    enabled: enabled && isCurrent() && !debouncing,
    retry: false,
    gcTime: 60_000,
  });
  const selection = useQuery({
    queryKey: selectedBuyerKey(scope, selectedId),
    queryFn: ({ signal }) =>
      readAuthorizedBuyer(scope, selectedId!, getParty, current, signal),
    enabled: enabled && isCurrent() && !!selectedId,
    staleTime: 0,
    retry: false,
    gcTime: 60_000,
  });
  const resolveBuyer = useCallback(
    async (id: string) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        return await readAuthorizedBuyer(
          scope,
          id,
          getParty,
          current,
          controller.signal,
        );
      } finally {
        controllers.current.delete(controller);
      }
    },
    [scope, current],
  );

  const available = enabled && isCurrent();
  return {
    search,
    setSearch: (value: string) => {
      void queryClient.cancelQueries({ queryKey: pageKey, exact: true });
      setOffset(0);
      setSearchValue(value.slice(0, 120));
    },
    offset,
    ...buyerPageView(available, debouncing, page),
    available,
    retry: () => {
      if (isCurrent()) void page.refetch();
    },
    previous: () => setOffset((value) => Math.max(0, value - BUYER_PAGE_SIZE)),
    next: () => {
      if (page.data?.hasNext) setOffset((value) => value + BUYER_PAGE_SIZE);
    },
    ...buyerSelectionView(available, selectedId, selection),
    retrySelection: () => {
      if (isCurrent()) void selection.refetch();
    },
    resolveBuyer,
    isCurrent,
  };
}

export type BuyerPickerState = ReturnType<typeof useBuyerPicker>;
