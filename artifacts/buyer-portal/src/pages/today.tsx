import { useLocation } from "wouter";
import {
  getGetWorkspaceTodayQueryKey,
  useGetWorkspaceToday,
} from "@workspace/api-client-react";
import { TodayWorkspace, trackUsabilityEvent } from "@workspace/web-ui";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

export function Today() {
  usePageTitle("Today");
  const [, navigate] = useLocation();
  const { data, isLoading, error, refetch } = useGetWorkspaceToday(
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
  if (!data || error) {
    return <QueryError thing="today's workspace" onRetry={() => void refetch()} />;
  }
  return (
    <TodayWorkspace
      eyebrow="Valo Today"
      title="Buyer work today"
      description="Stamped invoices awaiting review and supplier follow-ups are ordered by urgency."
      summary={data.summary}
      items={data.items}
      setup={data.setup}
      generatedAt={data.generatedAt}
      onOpen={(href, item) => {
        if (item) trackUsabilityEvent("today_item_opened", "today");
        navigate(href);
      }}
    />
  );
}
