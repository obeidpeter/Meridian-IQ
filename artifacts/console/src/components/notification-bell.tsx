import {
  useListNotifications,
  getListNotificationsQueryKey,
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

// Notification inbox: the firm's recent alert fan-out, straight from the
// messaging ledger. There is no per-user read state server-side, so the
// badge is honestly a RECENT count (the feed length), never "unread".
// Render-on-success: a server without the endpoint (older build → 404), or
// a principal without a feed, shows no bell at all. Channel labels/tones and
// the relative-time buckets come from lib/notifications — the SME app's
// vocabulary, mirrored by a parity test in each app.

/**
 * The bell badge: null hides it entirely on an empty feed (a zero would read
 * as noise), and the capped "20+" says "at least this many" once the feed
 * hits its query limit.
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count >= NOTIFICATION_FEED_LIMIT) return `${NOTIFICATION_FEED_LIMIT}+`;
  return String(count);
}

export function NotificationBell() {
  const params = { limit: NOTIFICATION_FEED_LIMIT };
  const { data: feed, isSuccess } = useListNotifications(params, {
    query: { queryKey: getListNotificationsQueryKey(params), retry: false },
  });
  if (!isSuccess || !feed) return null;
  const badge = badgeText(feed.items.length);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={`Notifications — ${feed.items.length} recent`}
          data-testid="button-notifications"
        >
          <Bell className="size-4" aria-hidden="true" />
          {badge && (
            <span
              className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-teal-700 px-1 text-[10px] font-bold leading-4 text-white"
              data-testid="badge-notification-count"
            >
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b px-4 py-2.5 text-xs font-bold uppercase text-muted-foreground">
          Recent notifications
        </p>
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
                className="space-y-1 px-4 py-2.5"
                data-testid={`row-notification-${n.id}`}
              >
                <p className="text-sm leading-5">{n.title}</p>
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
