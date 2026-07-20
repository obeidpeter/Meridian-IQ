import { describe, expect, test } from "vitest";
import {
  channelBadgeClasses,
  channelLabel,
  relativeTime,
} from "./notifications";

describe("channelLabel", () => {
  test("names the known delivery channels with their proper casing", () => {
    expect(channelLabel("email")).toBe("Email");
    expect(channelLabel("push")).toBe("Push");
    expect(channelLabel("sms")).toBe("SMS");
    expect(channelLabel("whatsapp")).toBe("WhatsApp");
  });

  test("humanizes an unknown channel instead of breaking the feed", () => {
    expect(channelLabel("carrier_pigeon")).toBe("Carrier pigeon");
  });
});

describe("channelBadgeClasses", () => {
  test("tones the known channels and falls back to slate", () => {
    expect(channelBadgeClasses("email")).toContain("blue");
    expect(channelBadgeClasses("whatsapp")).toContain("emerald");
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
