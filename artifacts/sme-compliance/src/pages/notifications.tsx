import { useMemo } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListNotificationsQueryKey,
  useListNotifications,
  useMarkNotificationsRead,
  type NotificationFeedItemsItem,
} from "@workspace/api-client-react";
import { Bell, CheckCheck, MailCheck, MessageSquareText } from "lucide-react";
import {
  Metric,
  MetricStrip,
  NotificationFeed,
  SegmentedControl,
  WorkspaceHeader,
  useUrlTab,
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

const FEED_VIEWS = ["all", "unread", "email", "sms"] as const;
type FeedView = (typeof FEED_VIEWS)[number];
const PARAMS = { limit: 100 };

function entityHref(item: NotificationFeedItemsItem) {
  if (item.entityType === "invoice" && item.entityId) {
    return `/invoices/${item.entityId}`;
  }
  if (item.entityType === "filing") return "/filings";
  if (item.entityType === "obligation") return "/obligations";
  return null;
}

export function Notifications() {
  usePageTitle("Notifications");
  const [view, setView] = useUrlTab<FeedView>("view", "all", FEED_VIEWS);
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
      onSuccess: (feed) => {
        queryClient.setQueryData(getListNotificationsQueryKey(PARAMS), feed);
      },
    },
  });
  const items = useMemo(() => query.data?.items ?? [], [query.data?.items]);
  const filtered = useMemo(() => {
    if (view === "unread") return items.filter((item) => !item.read);
    if (view === "email")
      return items.filter((item) => item.channel === "email");
    if (view === "sms") {
      return items.filter((item) => ["sms", "whatsapp"].includes(item.channel));
    }
    return items;
  }, [items, view]);
  const upToCreatedAt = markReadTimestamp(query.data);
  const delivered = items.filter((item) => item.status === "sent").length;
  const channels = new Set(items.map((item) => item.channel)).size;

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
        description="Every alert MeridianIQ sent, with its delivery channel, read state and related record."
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
          detail="Still requiring review"
          icon={<Bell className="size-4" aria-hidden="true" />}
          tone={(query.data?.unreadCount ?? 0) > 0 ? "info" : "default"}
        />
        <Metric
          label="Recent"
          value={String(items.length)}
          detail="Latest 100 messages"
          icon={<MessageSquareText className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Delivered"
          value={String(delivered)}
          detail="Provider accepted"
          icon={<MailCheck className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="Channels"
          value={String(channels)}
          detail="Used in this feed"
          icon={<MessageSquareText className="size-4" aria-hidden="true" />}
        />
      </MetricStrip>

      <SegmentedControl<FeedView>
        value={view}
        onChange={setView}
        label="Notification filter"
        items={[
          { value: "all", label: "All", count: items.length },
          {
            value: "unread",
            label: "Unread",
            count: query.data?.unreadCount ?? 0,
          },
          { value: "email", label: "Email" },
          { value: "sms", label: "SMS & WhatsApp" },
        ]}
      />

      <NotificationFeed
        rows={filtered.map((item) => ({
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
        emptyTitle="No notifications here"
        emptyHint="Change the filter or return when a new alert is delivered."
        renderLink={(href, children, key) => (
          <Link
            key={key}
            href={href}
            className="flex items-start gap-3 px-5 py-4 transition-colors hover:bg-slate-50"
          >
            {children}
          </Link>
        )}
      />
    </div>
  );
}
