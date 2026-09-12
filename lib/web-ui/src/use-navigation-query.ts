import { useCallback, useContext, useSyncExternalStore } from "react";
import { NavigationContext } from "./navigation-context";

const queryChangeEvent = "valo:querychange";
function subscribeQuery(listener: () => void) {
  window.addEventListener("popstate", listener);
  window.addEventListener(queryChangeEvent, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(queryChangeEvent, listener);
  };
}

// Existing URL-backed tabs/filters share the accepted router snapshot. Their
// query must not jump to a blocked Back target while history is being restored.
export function useNavigationQuery(): [
  string,
  (param: string, value: string | null) => void,
] {
  const navigation = useContext(NavigationContext);
  const read = useCallback(
    () =>
      navigation ? navigation.getSnapshot().search : window.location.search,
    [navigation],
  );
  const search = useSyncExternalStore(
    navigation?.subscribe ?? subscribeQuery,
    read,
  );
  const replace = useCallback(
    (param: string, value: string | null) => {
      const snapshot = navigation?.getSnapshot();
      const url = new URL(
        snapshot
          ? snapshot.pathname + snapshot.search + snapshot.hash
          : window.location.href,
        window.location.origin,
      );
      if (value === null) url.searchParams.delete(param);
      else url.searchParams.set(param, value);
      if (navigation) {
        navigation.navigate(url, { replace: true, state: snapshot?.state });
      } else {
        window.history.replaceState(window.history.state, "", url);
        window.dispatchEvent(new Event(queryChangeEvent));
      }
    },
    [navigation],
  );
  return [search, replace];
}
