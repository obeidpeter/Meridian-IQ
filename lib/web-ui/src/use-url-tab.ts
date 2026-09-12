import { useCallback, useRef } from "react";
import { useNavigationQuery } from "./unsaved-work";

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

  const [search, replace] = useNavigationQuery();
  const raw = new URLSearchParams(search).get(param);
  const tab =
    raw !== null && (values as readonly string[]).includes(raw)
      ? (raw as T)
      : fallback;

  const select = useCallback(
    (next: T) => {
      const { param, fallback } = latest.current;
      replace(param, next === fallback ? null : next);
    },
    [replace],
  );

  return [tab, select];
}
