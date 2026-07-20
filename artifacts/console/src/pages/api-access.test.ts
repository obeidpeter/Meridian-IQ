import { test, expect, describe } from "vitest";
import {
  MACHINE_CAPABILITY_OPTIONS,
  WEBHOOK_EVENT_OPTIONS,
  SIGNATURE_NOTE,
  toggleListValue,
  apiKeyStatusLabel,
  apiKeyBadgeClasses,
  webhookStatusLabel,
  webhookBadgeClasses,
  deliveryStatusLabel,
  deliveryBadgeClasses,
  webhookUrlProblem,
  lastUsedLine,
} from "./api-access";

// Helpers for the firm-admin API & webhooks page. The two option catalogues
// are MIRRORS of the server's allowlists (api-keys.ts MACHINE_CAPABILITIES,
// webhooks.ts WEBHOOK_EVENTS) — the pins below fail if either side drifts,
// so the dialogs can never offer something the server would reject.

describe("MACHINE_CAPABILITY_OPTIONS", () => {
  test("offers exactly the server's machine-safe allowlist, in order", () => {
    expect(MACHINE_CAPABILITY_OPTIONS.map((o) => o.value)).toEqual([
      "invoice.read",
      "invoice.write",
      "statement.write",
    ]);
  });

  test("every option explains itself", () => {
    for (const option of MACHINE_CAPABILITY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });
});

describe("WEBHOOK_EVENT_OPTIONS", () => {
  test("offers exactly the server's event catalogue, in order", () => {
    expect(WEBHOOK_EVENT_OPTIONS.map((o) => o.value)).toEqual([
      "invoice.stamped",
      "invoice.settled",
      "statement.reconciled",
    ]);
  });
});

describe("SIGNATURE_NOTE", () => {
  test("states the exact signing recipe — the stored hash is the HMAC key", () => {
    // A receiver who keys the HMAC with the raw secret rejects every genuine
    // delivery, so the note must carry this recipe verbatim.
    expect(SIGNATURE_NOTE).toContain(
      "HMAC-SHA256 of the body keyed by sha256 of your secret",
    );
    expect(SIGNATURE_NOTE).toContain("X-Meridian-Signature");
  });
});

describe("toggleListValue", () => {
  test("adds a missing value at the end, preserving pick order", () => {
    expect(toggleListValue([], "a")).toEqual(["a"]);
    expect(toggleListValue(["b"], "a")).toEqual(["b", "a"]);
  });

  test("removes a present value without touching the rest", () => {
    expect(toggleListValue(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  test("returns a new array — never mutates the selection state", () => {
    const before = ["a"];
    toggleListValue(before, "b");
    expect(before).toEqual(["a"]);
  });
});

describe("API key status", () => {
  test("live until the revocation stamp exists", () => {
    expect(apiKeyStatusLabel({ revokedAt: null })).toBe("Active");
    expect(apiKeyBadgeClasses({ revokedAt: null })).toContain("emerald");
  });

  test("a revoked key reads as revoked in a neutral tone", () => {
    expect(apiKeyStatusLabel({ revokedAt: "2026-07-01T00:00:00Z" })).toBe(
      "Revoked",
    );
    expect(
      apiKeyBadgeClasses({ revokedAt: "2026-07-01T00:00:00Z" }),
    ).toContain("slate");
  });
});

describe("webhook status", () => {
  test("active endpoints are emerald, disabled ones neutral", () => {
    expect(webhookStatusLabel({ active: true })).toBe("Active");
    expect(webhookBadgeClasses({ active: true })).toContain("emerald");
    expect(webhookStatusLabel({ active: false })).toBe("Disabled");
    expect(webhookBadgeClasses({ active: false })).toContain("slate");
  });
});

describe("delivery status", () => {
  test("maps each dispatcher status to its meaning and tone", () => {
    expect(deliveryStatusLabel("pending")).toBe("Queued");
    expect(deliveryBadgeClasses("pending")).toContain("blue");
    expect(deliveryStatusLabel("delivered")).toBe("Delivered");
    expect(deliveryBadgeClasses("delivered")).toContain("emerald");
    // failed = an attempt failed but retries remain; dead = gave up.
    expect(deliveryStatusLabel("failed")).toBe("Failed — retrying");
    expect(deliveryBadgeClasses("failed")).toContain("amber");
    expect(deliveryStatusLabel("dead")).toBe("Dead — gave up");
    expect(deliveryBadgeClasses("dead")).toContain("red");
  });

  test("a status from a newer server humanizes into a slate pill", () => {
    expect(deliveryStatusLabel("snoozed")).toBe("Snoozed");
    expect(deliveryBadgeClasses("snoozed")).toContain("slate");
  });
});

describe("webhookUrlProblem", () => {
  test("asks for a URL when the field is empty", () => {
    expect(webhookUrlProblem("")).toBe("Enter the endpoint URL.");
    expect(webhookUrlProblem("   ")).toBe("Enter the endpoint URL.");
  });

  test("rejects text that does not parse as a URL", () => {
    expect(webhookUrlProblem("not a url")).toContain("full URL");
    expect(webhookUrlProblem("example.com/hooks")).toContain("full URL");
  });

  test("rejects non-http(s) schemes", () => {
    expect(webhookUrlProblem("ftp://example.com/x")).toBe(
      "The endpoint must use http(s).",
    );
  });

  test("accepts http(s) URLs — the server stays the authority on the rest", () => {
    expect(webhookUrlProblem("https://example.com/hooks/meridian")).toBeNull();
    expect(webhookUrlProblem("http://example.com/hooks")).toBeNull();
  });
});

describe("lastUsedLine", () => {
  test("a used key names the moment; an unused key says so honestly", () => {
    expect(lastUsedLine({ lastUsedAt: "2026-07-01T09:30:00Z" })).toContain(
      "Last used",
    );
    expect(lastUsedLine({ lastUsedAt: null })).toBe("Never used");
  });
});
