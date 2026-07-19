import { useEffect } from "react";

/** Sets the document title to "{Page} · MeridianIQ" for the current route. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · MeridianIQ`;
    return () => {
      document.title = "MeridianIQ";
    };
  }, [title]);
}
