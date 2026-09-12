import { useCallback, useRef } from "react";
import { useNavigationQuery } from "./unsaved-work";

/**
 * Free-text state backed by a query parameter — the useUrlTab pattern without
 * the closed value list, for filters like a search box. A reload, deep link
 * or back/forward restores the filter instead of silently resetting it
 * (recognition over recall: the page shows the state it is in). Writes use
 * replaceState so typing never grows the history stack; the parameter is
 * dropped entirely while equal to the fallback, keeping default URLs clean.
 */
export function useUrlParam(
  param: string,
  fallback = "",
): [string, (next: string) => void] {
  const latest = useRef({ param, fallback });
  latest.current = { param, fallback };

  const [search, replace] = useNavigationQuery();
  const value = new URLSearchParams(search).get(param) ?? fallback;

  const set = useCallback(
    (next: string) => {
      const { param, fallback } = latest.current;
      replace(param, next === fallback ? null : next);
    },
    [replace],
  );

  return [value, set];
}
