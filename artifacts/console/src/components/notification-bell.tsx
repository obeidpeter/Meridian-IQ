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
import { pillClasses, type BadgeTone } from "@/lib/format";

// Notification inbox: the firm's recent alert fan-out, straight from the
// messaging ledger. There is no per-user read state server-side, so the
// badge is honestly a RECENT count (the feed length), never "unread".
// Render-on-success: a server without the endpoint (older build → 404), or
// a principal without a feed, shows no bell at all.

const FEED_LIMIT = 20;

export const CHANNEL_TONE: Record<string, BadgeTone> = {
  email: "blue",
  push: "violet",
  sms: "amber",
  whatsapp: "emerald",
};

/** "whatsapp" -> "whatsapp", "in_app" -> "in app" — chips read as prose. */
export function channelLabel(channel: string): string {
  return channel.replace(/_/g, " ");
}

/**
 * The bell badge: null hides it entirely on an empty feed (a zero would read
 * as noise), and the capped "20+" says "at least this many" once the feed
 * hits its query limit.
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count >= FEED_LIMIT) return `${FEED_LIMIT}+`;
  return String(count);
}

// Coarse relative time for feed rows — same shape as the clerk queue's claim
// ages; precision doesn't matter here.
export function notificationAge(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function NotificationBell() {
  const params = { limit: FEED_LIMIT };
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
            Nothing yet.
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
                  <span className={pillClasses(CHANNEL_TONE[n.channel] ?? "slate")}>
                    {channelLabel(n.channel)}
                  </span>
                  <span>{notificationAge(n.createdAt)}</span>
                </p>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
