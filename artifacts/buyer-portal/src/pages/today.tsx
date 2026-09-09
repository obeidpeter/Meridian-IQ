import { useLocation } from "wouter";
import {
  getGetWorkspaceTodayQueryKey,
  useGetWorkspaceToday,
} from "@workspace/api-client-react";
import { TodayWorkspace, trackUsabilityEvent } from "@workspace/web-ui";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { RefreshCw } from "lucide-react";

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "This workspace could not be loaded.";
}

export function Today() {
  usePageTitle("Today");
  const [, navigate] = useLocation();
  const { data, isLoading, isFetching, error, refetch } = useGetWorkspaceToday(
    { limit: 24 },
    {
      query: {
        queryKey: getGetWorkspaceTodayQueryKey({ limit: 24 }),
        staleTime: 30_000,
      },
    },
  );
  if (isLoading && !data) {
    return (
      <div className="space-y-4" role="status">
        <span className="sr-only">Loading today&apos;s priorities…</span>
        <div className="h-24 animate-pulse rounded-md bg-muted" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="h-28 animate-pulse rounded-md bg-muted" />
          ))}
        </div>
        <div className="h-80 animate-pulse rounded-md bg-muted" />
      </div>
    );
  }
  if (!data) {
    return (
      <QueryError thing="today's workspace" onRetry={() => void refetch()} />
    );
  }
  return (
    <>
      {error ? (
        <div className="mi-collaboration__error" role="alert">
          <span>
            Today's workspace could not be refreshed. Showing the last loaded
            priorities.
          </span>
          <button
            type="button"
            className="mi-button-quiet"
            onClick={() => void refetch()}
          >
            <RefreshCw aria-hidden="true" />
            Retry
          </button>
        </div>
      ) : null}
      {/* R113: the setup checklist is confirmed only by a successful read.
          After a failed refresh the cached queue stays useful, but the
          checklist reports unavailable instead of a stale percentage. */}
      <TodayWorkspace
        eyebrow="Valo Today"
        title="Buyer work today"
        description="Stamped invoices awaiting review and supplier follow-ups are ordered by urgency."
        summary={data.summary}
        items={data.items}
        setup={data.setup}
        setupError={error ? errorMessage(error) : null}
        setupLoading={Boolean(error) && isFetching}
        onRetrySetup={() => void refetch()}
        generatedAt={data.generatedAt}
        onOpen={(href, item) => {
          if (item) trackUsabilityEvent("today_item_opened", "today");
          navigate(href);
        }}
      />
    </>
  );
}
