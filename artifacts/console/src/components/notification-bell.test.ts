import { test, expect, describe } from "vitest";
import { badgeText } from "./notification-bell";

// Notification bell helpers. The bell itself is render-on-success (a server
// without /notifications hides it), and its badge is a RECENT count — the
// feed has no per-user read state, so it must never claim to be "unread".
// Channel labels/tones and relative time moved to lib/notifications (the SME
// vocabulary, pinned by that module's parity test).

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
