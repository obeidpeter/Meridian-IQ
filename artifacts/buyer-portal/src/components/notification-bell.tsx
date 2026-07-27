import { useEffect, useRef, useState } from "react";
import { Bell } from "lucide-react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationsRead,
  getListNotificationsQueryKey,
  type ListNotificationsParams,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import {
  badgeText,
  channelBadgeClasses,
  channelLabel,
  markReadTimestamp,
  NOTIFICATION_FEED_LIMIT,
  relativeTime,
} from "@/lib/notifications";

const FEED_PARAMS: ListNotificationsParams = { limit: NOTIFICATION_FEED_LIMIT };

/**
 * Bell + popover for the signed-in buyer's own notification feed (the alerts
 * the platform actually sent them, resolved from the pointer-only messages
 * ledger) — the SME app's bell, adapted to this portal. The feed carries
 * per-user read state (contract 0.41.0), so the bell fetches on mount — one
 * small query, 60s stale — to drive a real UNREAD badge; rows the user has
 * not read are visually distinct, and "Mark all read" stamps everything up
 * to the newest visible item, refreshing the feed from the endpoint's
 * returned payload. The badge/mark-read/vocabulary helpers all come from
 * lib/notifications (the shared @workspace/format module). The popover is a
 * small hand-rolled panel — this app does not ship the Radix popover
 * primitive — dismissed on Escape, outside pointer-down, and any wouter
 * navigation.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();

  // Navigating to another page closes the popover — a bell left open must
  // not float over the next screen.
  useEffect(() => {
    setOpen(false);
  }, [location]);

  // Light dismiss: Escape anywhere, or a pointer-down outside the bell and
  // its panel.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const container = containerRef.current;
      if (container && e.target instanceof Node && !container.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

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
    <div ref={containerRef} className="relative">
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={
          unread > 0 ? `Notifications — ${unread} unread` : "Notifications"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-md border bg-popover p-0 text-popover-foreground shadow-md"
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
                onClick={() => markRead.mutate({ data: { upToCreatedAt } })}
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
        </div>
      )}
    </div>
  );
}
