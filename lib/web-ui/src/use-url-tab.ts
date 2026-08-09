import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Tab state backed by a query parameter, so a reload, a deep link or
 * browser navigation lands on the tab the user was reading instead of the
 * page's default. Selection writes use replaceState — switching tabs must
 * not grow the history stack — and the popstate listener re-reads the URL
 * so back/forward between real history entries restores the tab each one
 * carried. The parameter is dropped entirely while on the fallback tab,
 * keeping default URLs clean.
 */
export function useUrlTab<T extends string>(
  param: string,
  fallback: T,
  values: readonly T[],
): [T, (next: T) => void] {
  // Callers pass literal arrays, so pin the latest inputs behind a ref and
  // keep every callback identity-stable across renders.
  const latest = useRef({ param, fallback, values });
  latest.current = { param, fallback, values };

  const read = useCallback((): T => {
    const { param, fallback, values } = latest.current;
    const raw = new URLSearchParams(window.location.search).get(param);
    return raw !== null && (values as readonly string[]).includes(raw)
      ? (raw as T)
      : fallback;
  }, []);

  const [tab, setTab] = useState<T>(read);

  useEffect(() => {
    const onPopState = () => setTab(read());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [read]);

  const select = useCallback(
    (next: T) => {
      setTab(next);
      const { param, fallback } = latest.current;
      const url = new URL(window.location.href);
      if (next === fallback) url.searchParams.delete(param);
      else url.searchParams.set(param, next);
      window.history.replaceState(window.history.state, "", url);
    },
    [],
  );

  return [tab, select];
}
