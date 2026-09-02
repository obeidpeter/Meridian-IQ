import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  getListNotificationsQueryKey,
  useListNotifications,
  useMarkNotificationsRead,
} from "@workspace/api-client-react";
import { Bell, CheckCheck, MailCheck } from "lucide-react";
import {
  Metric,
  MetricStrip,
  NotificationFeed,
  WorkspaceHeader,
} from "@workspace/web-ui";
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


/** A confirmation alert opens the invoice it is about; anything else stays a row. */
function entityHref(item: { entityType?: string | null; entityId?: string | null }) {
  if (item.entityType === "invoice" && item.entityId) {
    return `/invoices/${item.entityId}`;
  }
  return null;
}

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
          detail="Sent to you"
          icon={<MailCheck className="size-4" aria-hidden="true" />}
          tone="positive"
        />
      </MetricStrip>

      <NotificationFeed
        rows={items.map((item) => ({
          id: item.id,
          title: item.title,
          read: item.read,
          channelBadgeClass: channelBadgeClasses(item.channel),
          channelLabel: channelLabel(item.channel),
          timeLabel: relativeTime(item.createdAt),
          timeTitle: formatDateTime(item.createdAt),
          status: item.status,
          href: entityHref(item),
        }))}
        emptyTitle="No notifications yet"
        emptyHint="Confirmation alerts and supplier updates will appear here."
        unreadDotClass="bg-cyan-600"
        renderLink={(href, children, key) => (
          <Link
            key={key}
            href={href}
            className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50"
            data-testid={`link-notification-${key}`}
          >
            {children}
          </Link>
        )}
      />
    </div>
  );
}
