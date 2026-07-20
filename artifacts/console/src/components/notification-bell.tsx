import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationsRead,
  getListNotificationsQueryKey,
  type NotificationFeed,
} from "@workspace/api-client-react";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDateTime } from "@/lib/format";
import {
  channelBadgeClasses,
  channelLabel,
  NOTIFICATION_FEED_LIMIT,
  relativeTime,
} from "@/lib/notifications";

// Notification inbox: the signed-in user's own alert fan-out, straight from
// the messaging ledger. The feed carries per-user read state (contract
// 0.41.0), so the badge is a real UNREAD count now; unread rows are visually
// distinct and "Mark all read" stamps everything up to the newest visible
// item, refreshing the feed from the endpoint's returned payload.
// Render-on-success: a server without the endpoint (older build → 404), or
// a principal without a feed, shows no bell at all. Channel labels/tones and
// the relative-time buckets come from lib/notifications — the SME app's
// vocabulary, mirrored by a parity test in each app.

/**
 * The bell badge: null hides it entirely when nothing is unread (a zero
 * would read as noise), and the capped "20+" says "at least this many" once
 * the unread count reaches the feed's page size.
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count >= NOTIFICATION_FEED_LIMIT) return `${NOTIFICATION_FEED_LIMIT}+`;
  return String(count);
}

/**
 * The timestamp handed to mark-read: the newest item's createdAt (the feed
 * is newest-first), so "mark all read" covers exactly what the user has seen
 * — an item that lands mid-click stays unread. Null when there is nothing to
 * mark.
 */
export function markReadTimestamp(
  feed: NotificationFeed | undefined,
): string | null {
  return feed?.items[0]?.createdAt ?? null;
}

export function NotificationBell() {
  const params = { limit: NOTIFICATION_FEED_LIMIT };
  const queryClient = useQueryClient();
  const { data: feed, isSuccess } = useListNotifications(params, {
    query: { queryKey: getListNotificationsQueryKey(params), retry: false },
  });
  const markRead = useMarkNotificationsRead({
    mutation: {
      // The endpoint returns the refreshed feed — seed the cache with it so
      // badge and rows settle together, without a second round trip.
      onSuccess: (refreshed) => {
        queryClient.setQueryData(
          getListNotificationsQueryKey(params),
          refreshed,
        );
      },
    },
  });
  if (!isSuccess || !feed) return null;
  const badge = badgeText(feed.unreadCount);
  const upToCreatedAt = markReadTimestamp(feed);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            feed.unreadCount > 0
              ? `Notifications — ${feed.unreadCount} unread`
              : "Notifications"
          }
          data-testid="button-notifications"
        >
          <Bell className="size-4" aria-hidden="true" />
          {badge && (
            <span
              className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-teal-700 px-1 text-[10px] font-bold leading-4 text-white"
              aria-hidden="true"
              data-testid="badge-notification-count"
            >
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-4 py-2">
          <p className="text-xs font-bold uppercase text-muted-foreground">
            Notifications
          </p>
          {feed.unreadCount > 0 && upToCreatedAt && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={markRead.isPending}
              onClick={() => markRead.mutate({ data: { upToCreatedAt } })}
              data-testid="button-mark-all-read"
            >
              {markRead.isPending ? "Marking…" : "Mark all read"}
            </Button>
          )}
        </div>
        {feed.items.length === 0 ? (
          <p
            className="px-4 py-6 text-center text-sm text-muted-foreground"
            data-testid="text-notifications-empty"
          >
            Nothing yet — alerts we send you will show up here.
          </p>
        ) : (
          <ul
            className="max-h-96 divide-y overflow-y-auto"
            data-testid="list-notifications"
          >
            {feed.items.map((n) => (
              <li
                key={n.id}
                className={`space-y-1 px-4 py-2.5 ${
                  n.read ? "" : "bg-teal-700/5"
                }`}
                data-testid={`row-notification-${n.id}`}
              >
                <p
                  className={`flex items-start gap-1.5 text-sm leading-5 ${
                    n.read ? "" : "font-semibold"
                  }`}
                >
                  {!n.read && (
                    <>
                      <span
                        className="mt-1.5 size-2 shrink-0 rounded-full bg-teal-700"
                        aria-hidden="true"
                      />
                      <span className="sr-only">Unread — </span>
                    </>
                  )}
                  <span className="min-w-0">{n.title}</span>
                </p>
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={channelBadgeClasses(n.channel)}>
                    {channelLabel(n.channel)}
                  </span>
                  <span title={formatDateTime(n.createdAt)}>
                    {relativeTime(n.createdAt)}
                  </span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
