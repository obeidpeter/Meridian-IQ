import { test, expect, describe } from "vitest";
import type { NotificationFeed } from "@workspace/api-client-react";
import { badgeText, markReadTimestamp } from "./notification-bell";

// Notification bell helpers. The bell itself is render-on-success (a server
// without /notifications hides it). The feed carries per-user read state
// (contract 0.41.0), so the badge is a real UNREAD count, and "Mark all
// read" stamps everything up to the newest visible item. Channel
// labels/tones and relative time live in lib/notifications (the SME
// vocabulary, pinned by that module's parity test).

describe("badgeText", () => {
  test("nothing unread hides the badge entirely — zero would read as noise", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
  });

  test("counts below the feed page size render as-is", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(19)).toBe("19");
  });

  test("a count at the page size caps with a plus — 'at least this many'", () => {
    expect(badgeText(20)).toBe("20+");
    expect(badgeText(80)).toBe("20+");
  });
});

describe("markReadTimestamp", () => {
  const item = (
    over: Partial<NotificationFeed["items"][number]> = {},
  ): NotificationFeed["items"][number] => ({
    id: "n1",
    channel: "email",
    templateKey: "deadline_reminder",
    title: "Submission window closes tomorrow",
    status: "sent",
    read: false,
    createdAt: "2026-07-20T10:00:00Z",
    ...over,
  });

  test("hands mark-read the newest item's createdAt (the feed is newest-first)", () => {
    const feed: NotificationFeed = {
      items: [
        item({ id: "newest", createdAt: "2026-07-20T10:00:00Z" }),
        item({ id: "older", createdAt: "2026-07-19T09:00:00Z" }),
      ],
      unreadCount: 2,
    };
    expect(markReadTimestamp(feed)).toBe("2026-07-20T10:00:00Z");
  });

  test("an empty or absent feed has nothing to mark", () => {
    expect(markReadTimestamp({ items: [], unreadCount: 0 })).toBeNull();
    expect(markReadTimestamp(undefined)).toBeNull();
  });
});
