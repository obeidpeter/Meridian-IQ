// Pure display helpers for the notification bell's feed (contract 0.39.0:
// GET /notifications resolves the signed-in user's own rows from the
// pointer-only messages ledger). The channel vocabulary, relative-time
// buckets and badge/mark-read helpers are shared by the console and SME
// bells — each app's src/lib/notifications.ts re-exports this module, so a
// divergence is impossible by construction. The bell components own the
// popover DOM; these stay testable without it.

// Type-only, same as index.ts: erased at compile time.
import type { NotificationFeed } from "@workspace/api-zod";

import { formatDate, humanize, pillClasses, type BadgeTone } from "./index";

/** Rows requested for the bell's popover (the server caps limit at 100). */
export const NOTIFICATION_FEED_LIMIT = 20;

// The delivery channels the messaging rails send over today. Unknown values
// (a future channel on a newer server) humanize into a slate chip instead of
// breaking the feed.
const CHANNEL_LABELS: Record<string, string> = {
  email: "Email",
  push: "Push",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

const CHANNEL_TONES: Record<string, BadgeTone> = {
  email: "blue",
  push: "violet",
  sms: "teal",
  whatsapp: "emerald",
};

/** Chip label for a delivery channel ("whatsapp" → "WhatsApp"). */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? humanize(channel);
}

/** Pill classes for a delivery channel chip (slate for unknown channels). */
export function channelBadgeClasses(channel: string): string {
  return pillClasses(CHANNEL_TONES[channel] ?? "slate");
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact "how long ago" for the feed rows: "just now" under a minute, then
 * minutes/hours/days, and the shared date format past a week. Clock skew (a
 * timestamp slightly in the future) reads as "just now", never a negative
 * age; an unparseable timestamp falls back to formatDate's "—".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return formatDate(iso);
  const elapsed = now.getTime() - then;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return formatDate(iso);
}

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
