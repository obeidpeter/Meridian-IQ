import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { webSession } from "./session-coordinator";
import { RouteLoading } from "./route-recovery";

export function SessionBoundary({
  client,
  children,
}: {
  client: Parameters<typeof webSession.attach>[0];
  children: ReactNode;
}) {
  const ending = useSyncExternalStore(
    webSession.subscribe,
    webSession.isEnding,
    () => false,
  );
  useEffect(() => webSession.attach(client), [client]);
  return ending ? <RouteLoading label="Signing out" /> : children;
}
