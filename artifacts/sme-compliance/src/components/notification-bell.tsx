import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import {
  useListNotifications,
  getListNotificationsQueryKey,
  type ListNotificationsParams,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
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
 * ledger). The feed is fetched only while the popover is open — a page view
 * costs nothing — and renders on success only: title, delivery-channel chip
 * and a relative timestamp per row, with a friendly empty state.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useListNotifications(FEED_PARAMS, {
    query: {
      queryKey: getListNotificationsQueryKey(FEED_PARAMS),
      enabled: open,
      retry: false,
      staleTime: 60_000,
    },
  });

  // Light-dismiss: outside click or Escape closes, like the app's dialogs.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const items = data?.items ?? [];

  return (
    <div className="relative" ref={rootRef}>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Notifications"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="button-notifications"
      >
        <Bell className="w-5 h-5" aria-hidden="true" />
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          data-testid="popover-notifications"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-popover-border bg-popover text-popover-foreground shadow-lg"
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
        </div>
      )}
    </div>
  );
}
