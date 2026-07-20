import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationsRead,
  getListNotificationsQueryKey,
  type ListNotificationsParams,
  type NotificationFeed,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import {
  channelBadgeClasses,
  channelLabel,
  NOTIFICATION_FEED_LIMIT,
  relativeTime,
} from "@/lib/notifications";

const FEED_PARAMS: ListNotificationsParams = { limit: NOTIFICATION_FEED_LIMIT };

/**
 * The bell badge (mirror of the console's — the two apps have no shared UI
 * lib): null hides it entirely when nothing is unread (a zero would read as
 * noise), and the capped "20+" says "at least this many" once the server's
 * unread count reaches the feed's page size.
 */
export function badgeText(count: number): string | null {
  if (count <= 0) return null;
  if (count >= NOTIFICATION_FEED_LIMIT) return `${NOTIFICATION_FEED_LIMIT}+`;
  return String(count);
}

/**
 * The timestamp handed to mark-read: the newest item's createdAt (the feed is
 * newest-first), so "mark all read" covers exactly what the user has seen —
 * an item that lands mid-click stays unread. Null when there is nothing to
 * mark.
 */
export function markReadTimestamp(
  feed: NotificationFeed | undefined,
): string | null {
  return feed?.items[0]?.createdAt ?? null;
}

/**
 * Bell + popover for the signed-in user's own notification feed (the alerts
 * the platform actually sent them, resolved from the pointer-only messages
 * ledger). The feed now carries per-user read state (contract 0.41.0), so
 * the bell fetches on mount — one small query, 60s stale — to drive a real
 * UNREAD badge; rows the user has not read are visually distinct, and "Mark
 * all read" stamps everything up to the newest visible item, refreshing the
 * feed from the endpoint's returned payload. The popover is the Radix
 * primitive (the console's pattern), so focus management and dismissal —
 * Escape, outside click — come from the library instead of hand-rolled
 * document listeners; a wouter navigation also closes it.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const queryClient = useQueryClient();

  // Navigating to another page closes the popover — a bell left open must
  // not float over the next screen.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  const { data, isLoading, isError } = useListNotifications(FEED_PARAMS, {
    query: {
      queryKey: getListNotificationsQueryKey(FEED_PARAMS),
      retry: false,
      staleTime: 60_000,
    },
  });

  const markRead = useMarkNotificationsRead({
    mutation: {
      // The endpoint returns the refreshed feed — seed the cache with it so
      // badge and rows settle together, without a second round trip.
      onSuccess: (refreshed) => {
        queryClient.setQueryData(
          getListNotificationsQueryKey(FEED_PARAMS),
          refreshed,
        );
      },
    },
  });

  const items = data?.items ?? [];
  const unread = data?.unreadCount ?? 0;
  const badge = badgeText(unread);
  const upToCreatedAt = markReadTimestamp(data);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={
            unread > 0 ? `Notifications — ${unread} unread` : "Notifications"
          }
          data-testid="button-notifications"
        >
          <Bell className="w-5 h-5" aria-hidden="true" />
          {badge && (
            <span
              className="absolute right-0.5 top-0.5 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-bold leading-4 text-primary-foreground"
              aria-hidden="true"
              data-testid="badge-notification-count"
            >
              {badge}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        aria-label="Notifications"
        data-testid="popover-notifications"
      >
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-semibold">Notifications</p>
          {unread > 0 && upToCreatedAt && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
              disabled={markRead.isPending}
              onClick={() =>
                markRead.mutate({ data: { upToCreatedAt } })
              }
              data-testid="button-mark-all-read"
            >
              {markRead.isPending ? "Marking…" : "Mark all read"}
            </Button>
          )}
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {isLoading || (!data && !isError) ? (
            <div className="space-y-2 p-2">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : isError ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              Couldn&apos;t load your notifications just now — try again in a
              moment.
            </p>
          ) : items.length === 0 ? (
            <p
              className="px-3 py-6 text-center text-sm text-muted-foreground"
              data-testid="text-notifications-empty"
            >
              Nothing yet — alerts we send you will show up here.
            </p>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={`rounded-md px-2 py-2 hover:bg-muted/60 ${
                  n.read ? "" : "bg-primary/5"
                }`}
                data-testid={`row-notification-${n.id}`}
              >
                <p
                  className={`flex items-start gap-1.5 text-sm leading-snug ${
                    n.read ? "" : "font-medium"
                  }`}
                >
                  {!n.read && (
                    <>
                      <span
                        className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                        aria-hidden="true"
                      />
                      <span className="sr-only">Unread — </span>
                    </>
                  )}
                  <span className="min-w-0">{n.title}</span>
                </p>
                <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={channelBadgeClasses(n.channel)}>
                    {channelLabel(n.channel)}
                  </span>
                  <span title={formatDateTime(n.createdAt)}>
                    {relativeTime(n.createdAt)}
                  </span>
                </p>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
