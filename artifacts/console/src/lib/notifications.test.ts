import { describe, expect, test } from "vitest";
import {
  channelBadgeClasses,
  channelLabel,
  NOTIFICATION_FEED_LIMIT,
  relativeTime,
} from "./notifications";

// PARITY PIN — this module mirrors the SME app's src/lib/notifications.ts
// (no cross-app shared lib exists). The canonical channel vocabulary below
// is asserted verbatim in BOTH apps' suites, the mobile chip-parity idiom:
// a divergence fails one side's test and points at the other.

describe("channel vocabulary parity", () => {
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
