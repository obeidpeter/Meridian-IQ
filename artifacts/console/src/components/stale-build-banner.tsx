import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import {
  API_CONTRACT_VERSION,
  getHealthCheckQueryKey,
  useHealthCheck,
} from "@workspace/api-client-react";

// The console bundle bakes in the contract version its client was generated
// from; /healthz reports the version the running api-server was built with.
// When they differ, panels fail in confusing 404/schema-shaped ways — say so
// plainly once, app-wide, instead of letting each page discover it. A FAILING
// healthz proves nothing about version skew (the server may simply be down or
// restarting), so only a successful response with a different version renders
// the banner; retry: false keeps a dead server from being hammered.

// Dismissal is per browser session AND per server version: dismissing the
// warning for v0.1.0 keeps it hidden until the mismatch changes again.
const DISMISS_KEY = "console.stale-build-dismissed";

function storedDismissal(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function StaleBuildBanner() {
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(
    storedDismissal,
  );
  const { data } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      // Re-check when the operator comes back to the tab — that's exactly
      // when a restart may have (or should have) happened.
      refetchOnWindowFocus: true,
      staleTime: 60_000,
      retry: false,
    },
  });

  if (
    !data ||
    data.contractVersion === API_CONTRACT_VERSION ||
    data.contractVersion === dismissedVersion
  ) {
    return null;
  }

  const dismiss = () => {
    setDismissedVersion(data.contractVersion);
    try {
      window.sessionStorage.setItem(DISMISS_KEY, data.contractVersion);
    } catch {
      /* storage can be unavailable (private mode); state still hides it */
    }
  };

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-100 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
      data-testid="banner-stale-build"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
      <p className="flex-1">
        The server is running an older build (v{data.contractVersion} vs v
        {API_CONTRACT_VERSION}). Restart the api-server workflow — some panels
        may fail until then.
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss build warning"
        className="shrink-0 rounded-md p-0.5 transition-colors hover:bg-amber-200 dark:hover:bg-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        data-testid="button-dismiss-stale-build"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
