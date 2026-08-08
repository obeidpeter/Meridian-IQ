import { useQueryClient } from "@tanstack/react-query";
import {
  getListNotificationsQueryKey,
  useListNotifications,
  useMarkNotificationsRead,
} from "@workspace/api-client-react";
import { Bell, CheckCheck, MailCheck } from "lucide-react";
import { Metric, MetricStrip, WorkspaceHeader } from "@workspace/web-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatDateTime } from "@/lib/format";
import {
  channelBadgeClasses,
  channelLabel,
  markReadTimestamp,
  relativeTime,
} from "@/lib/notifications";

const PARAMS = { limit: 100 };

export function Notifications() {
  usePageTitle("Notifications");
  const queryClient = useQueryClient();
  const query = useListNotifications(PARAMS, {
    query: {
      queryKey: getListNotificationsQueryKey(PARAMS),
      retry: false,
      staleTime: 30_000,
    },
  });
  const markRead = useMarkNotificationsRead({
    mutation: {
      onSuccess: (feed) =>
        queryClient.setQueryData(getListNotificationsQueryKey(PARAMS), feed),
    },
  });
  const items = query.data?.items ?? [];
  const upToCreatedAt = markReadTimestamp(query.data);
  const delivered = items.filter((item) => item.status === "sent").length;

  if (query.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader eyebrow="Inbox" title="Notifications" />
        <QueryError
          thing="your notifications"
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Inbox"
        title="Notifications"
        description="Confirmation alerts and supplier updates sent to your buyer account."
        actions={
          query.data?.unreadCount && upToCreatedAt ? (
            <Button
              variant="outline"
              onClick={() => markRead.mutate({ data: { upToCreatedAt } })}
              disabled={markRead.isPending}
            >
              <CheckCheck className="mr-2 size-4" aria-hidden="true" />
              {markRead.isPending ? "Marking…" : "Mark all read"}
            </Button>
          ) : null
        }
      />

      <MetricStrip label="Notification summary">
        <Metric
          label="Unread"
          value={String(query.data?.unreadCount ?? 0)}
          detail="Awaiting review"
          icon={<Bell className="size-4" aria-hidden="true" />}
          tone={(query.data?.unreadCount ?? 0) > 0 ? "info" : "default"}
        />
        <Metric
          label="Recent"
          value={String(items.length)}
          detail="Latest messages"
          icon={<Bell className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Delivered"
          value={String(delivered)}
          detail="Provider accepted"
          icon={<MailCheck className="size-4" aria-hidden="true" />}
          tone="positive"
        />
      </MetricStrip>

      <section className="overflow-hidden border-y border-slate-200 bg-white">
        {items.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="font-bold text-slate-900">No notifications yet</p>
            <p className="mt-1 text-sm text-slate-500">
              Confirmation alerts and supplier updates will appear here.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-200">
            {items.map((item) => (
              <div key={item.id} className="flex items-start gap-3 px-5 py-4">
                <span
                  className={`mt-1.5 size-2 shrink-0 rounded-full ${
                    item.read ? "bg-slate-200" : "bg-cyan-600"
                  }`}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-sm ${
                      item.read
                        ? "font-medium text-slate-700"
                        : "font-bold text-slate-950"
                    }`}
                  >
                    {item.title}
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className={channelBadgeClasses(item.channel)}>
                      {channelLabel(item.channel)}
                    </span>
                    <span title={formatDateTime(item.createdAt)}>
                      {relativeTime(item.createdAt)}
                    </span>
                    <span>{item.status}</span>
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
