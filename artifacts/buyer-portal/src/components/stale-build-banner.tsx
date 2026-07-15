import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  useHealthCheck,
  getHealthCheckQueryKey,
  API_CONTRACT_VERSION,
} from "@workspace/api-client-react";

/**
 * App-wide warning shown when the api-server is running an older contract
 * build than the one this app was generated against. Only a SUCCESSFUL
 * healthz response with a different version renders the banner — a failing
 * healthz stays silent (retry: false so it never retry-spins either).
 *
 * Buyer wording: buyers are external counterparties, not firm staff, so the
 * banner reports the condition without the "restart the workflow" operator
 * instruction the console/SME copies carry.
 */
export function StaleBuildBanner() {
  // Per-session dismissal: plain component state, deliberately not persisted,
  // so the warning comes back on the next visit if the server is still stale.
  const [dismissed, setDismissed] = useState(false);
  const { data } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchOnWindowFocus: true,
      staleTime: 60_000,
      retry: false,
    },
  });

  if (dismissed || !data || data.contractVersion === API_CONTRACT_VERSION) {
    return null;
  }

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-200 bg-amber-100 px-4 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
      data-testid="banner-stale-server"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      <p className="flex-1">
        This portal was updated ahead of the server (v{data.contractVersion}{" "}
        vs v{API_CONTRACT_VERSION}). Some features may fail until the platform
        finishes updating.
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss server version warning"
        className="shrink-0 rounded-md p-1 transition-colors hover:bg-amber-200 dark:hover:bg-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-testid="button-dismiss-stale-banner"
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
