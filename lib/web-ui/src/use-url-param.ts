import { useCallback, useEffect, useRef, useState } from "react";

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

  const read = useCallback((): string => {
    const { param, fallback } = latest.current;
    const raw = new URLSearchParams(window.location.search).get(param);
    return raw ?? fallback;
  }, []);

  const [value, setValue] = useState<string>(read);

  useEffect(() => {
    const onPopState = () => setValue(read());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [read]);

  const set = useCallback((next: string) => {
    setValue(next);
    const { param, fallback } = latest.current;
    const url = new URL(window.location.href);
    if (next === fallback) url.searchParams.delete(param);
    else url.searchParams.set(param, next);
    window.history.replaceState(window.history.state, "", url);
  }, []);

  return [value, set];
}
