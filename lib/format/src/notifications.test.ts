import { describe, expect, test } from "vitest";
import {
  badgeText,
  channelBadgeClasses,
  channelLabel,
  markReadTimestamp,
  NOTIFICATION_FEED_LIMIT,
  relativeTime,
} from "./notifications";

// The one home for the bells' display vocabulary — the console and SME apps
// both re-export this module from their src/lib/notifications.ts, so the
// canonical channel set below is asserted once, here, instead of the old
// per-app parity-pin pair.

describe("channel vocabulary", () => {
  test("labels match the canonical set exactly", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("push")).toBe("Push");
    expect(channelLabel("sms")).toBe("SMS");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
  });

  test("tones match the canonical set exactly", () => {
    expect(channelBadgeClasses("email")).toContain("blue");
    expect(channelBadgeClasses("push")).toContain("violet");
    expect(channelBadgeClasses("sms")).toContain("teal");
    expect(channelBadgeClasses("whatsapp")).toContain("emerald");
  });

  test("both apps request the same feed page size", () => {
    expect(NOTIFICATION_FEED_LIMIT).toBe(20);
  });
});

describe("channelLabel", () => {
  test("humanizes an unknown channel instead of breaking the feed", () => {
    expect(channelLabel("carrier_pigeon")).toBe("Carrier pigeon");
  });
});

describe("channelBadgeClasses", () => {
  test("falls back to slate for unknown channels", () => {
    expect(channelBadgeClasses("carrier_pigeon")).toContain("slate");
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-07-20T12:00:00Z");

  test("buckets by age: just now, minutes, hours, days", () => {
    expect(relativeTime("2026-07-20T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-07-20T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-07-20T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-07-18T12:00:00Z", now)).toBe("2d ago");
  });

  test("falls back to the shared date format past a week", () => {
    expect(relativeTime("2026-07-01T12:00:00Z", now)).toBe("01 Jul 2026");
  });

  test("clock skew reads as just now, never a negative age", () => {
    expect(relativeTime("2026-07-20T12:00:45Z", now)).toBe("just now");
  });

  test("an unparseable timestamp renders the shared placeholder", () => {
    expect(relativeTime("not-a-date", now)).toBe("—");
  });
});

describe("badgeText", () => {
  test("hides at zero or below, shows exact counts, caps at the page size", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
    expect(badgeText(1)).toBe("1");
    expect(badgeText(19)).toBe("19");
    expect(badgeText(20)).toBe("20+");
    expect(badgeText(80)).toBe("20+");
  });
});

describe("markReadTimestamp", () => {
  const item = (id: string, createdAt: string) => ({
    id,
    channel: "email",
    templateKey: "t",
    title: "T",
    status: "sent",
    read: false,
    createdAt,
  });

  test("uses the newest (first) item's createdAt", () => {
    expect(
      markReadTimestamp({
        items: [
          item("a", "2026-07-20T10:00:00Z"),
          item("b", "2026-07-19T10:00:00Z"),
        ],
        unreadCount: 2,
      }),
    ).toBe("2026-07-20T10:00:00Z");
  });

  test("null when there is nothing to mark", () => {
    expect(markReadTimestamp({ items: [], unreadCount: 0 })).toBeNull();
    expect(markReadTimestamp(undefined)).toBeNull();
  });
});
