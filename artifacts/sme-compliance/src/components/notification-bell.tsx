import { useEffect, useState } from "react";
import { Bell } from "lucide-react";
import { useLocation } from "wouter";
import {
  useListNotifications,
  getListNotificationsQueryKey,
  type ListNotificationsParams,
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
 * Bell + popover for the signed-in user's own notification feed (the alerts
 * the platform actually sent them, resolved from the pointer-only messages
 * ledger). The popover is the Radix primitive (the console's pattern), so
 * focus management and dismissal — Escape, outside click — come from the
 * library instead of hand-rolled document listeners; a wouter navigation
 * also closes it. The feed is fetched only while the popover is open — a
 * page view costs nothing — and renders on success only: title,
 * delivery-channel chip and a relative timestamp per row, with a friendly
 * empty state.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();

  // Navigating to another page closes the popover — a bell left open must
  // not float over the next screen.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  const { data, isLoading, isError } = useListNotifications(FEED_PARAMS, {
    query: {
      queryKey: getListNotificationsQueryKey(FEED_PARAMS),
      enabled: open,
      retry: false,
      staleTime: 60_000,
    },
  });

  const items = data?.items ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Notifications"
          data-testid="button-notifications"
        >
          <Bell className="w-5 h-5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        aria-label="Notifications"
        data-testid="popover-notifications"
      >
        <p className="border-b px-3 py-2 text-sm font-semibold">
          Notifications
        </p>
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
                className="rounded-md px-2 py-2 hover:bg-muted/60"
                data-testid={`row-notification-${n.id}`}
              >
                <p className="text-sm leading-snug">{n.title}</p>
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
