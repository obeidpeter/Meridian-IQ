import { test, expect, describe } from "vitest";
import {
  CHANNEL_TONE,
  badgeText,
  channelLabel,
  notificationAge,
} from "./notification-bell";

// Notification bell helpers. The bell itself is render-on-success (a server
// without /notifications hides it), and its badge is a RECENT count — the
// feed has no per-user read state, so it must never claim to be "unread".

describe("badgeText", () => {
  test("an empty feed hides the badge entirely — zero would read as noise", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
  });

  test("counts below the query limit render as-is", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(19)).toBe("19");
  });

  test("a full page caps at the limit with a plus — 'at least this many'", () => {
    expect(badgeText(20)).toBe("20+");
    expect(badgeText(80)).toBe("20+");
  });
});

describe("channelLabel", () => {
  test("underscored wire values read as prose, plain ones pass through", () => {
    expect(channelLabel("in_app")).toBe("in app");
    expect(channelLabel("email")).toBe("email");
    expect(channelLabel("whatsapp")).toBe("whatsapp");
  });
});

describe("notificationAge", () => {
  test("fresh rows say 'just now', older ones step min → h → d", () => {
    const now = Date.now();
    expect(notificationAge(new Date(now).toISOString())).toBe("just now");
    expect(notificationAge(new Date(now - 5 * 60_000).toISOString())).toBe(
      "5 min ago",
    );
    expect(notificationAge(new Date(now - 3 * 3_600_000).toISOString())).toBe(
      "3 h ago",
    );
    expect(notificationAge(new Date(now - 49 * 3_600_000).toISOString())).toBe(
      "2 d ago",
    );
  });

  test("an unparseable timestamp renders as empty, never NaN", () => {
    expect(notificationAge("not-a-date")).toBe("");
  });
});

describe("CHANNEL_TONE", () => {
  test("every outbound channel the platform sends on carries a chip tone", () => {
    for (const channel of ["email", "push", "sms", "whatsapp"]) {
      expect(CHANNEL_TONE[channel]).toBeTruthy();
    }
  });
});
