import { useEffect } from "react";

/** Sets the document title to "{Page} · Valo" for the current route. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Valo`;
    return () => {
      document.title = "Valo";
    };
  }, [title]);
}
