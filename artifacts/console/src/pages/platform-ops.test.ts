import { test, expect, describe } from "vitest";
import {
  HEALTH_ALERT_ACTION_LABELS,
  HEALTH_ALERTS_EMPTY,
  RAIL_CONFIG_INTRO,
  healthAlertLabel,
  healthAlertEntityRef,
  railConfiguredLabel,
  railConfiguredBadgeClasses,
  railKeyIdsLine,
  railTransportLine,
  railNotConfiguredBadgeClasses,
  RAIL_NOT_CONFIGURED_LABEL,
} from "./platform-ops";

// Helpers behind the two operator observability cards. The action-label map
// is a MIRROR of the alert actions the server-side sweeps write to the audit
// ledger — the pin below fails if either side drifts, so a known alert can
// never silently degrade to a raw dotted action string.

describe("HEALTH_ALERT_ACTION_LABELS", () => {
  test("covers exactly the six known alert actions with their words", () => {
    expect(HEALTH_ALERT_ACTION_LABELS).toEqual({
      "ops.rail.circuit_open": "Rail circuit open",
      "ops.outbox.dead": "Dead-lettered event",
      "ops.webhook.delivery_dead": "Webhook delivery dead",
      "clerk.spend.anomaly": "Firm spend anomaly",
      "clerk.quality.drop": "Extraction quality drop",
      "clerk.injection_resistance.dropped": "Injection resistance drop",
    });
  });
});

describe("healthAlertLabel", () => {
  test("known actions resolve through the map", () => {
    expect(healthAlertLabel("ops.rail.circuit_open")).toBe("Rail circuit open");
    expect(healthAlertLabel("clerk.spend.anomaly")).toBe("Firm spend anomaly");
  });

  test("an action from a newer server humanizes instead of blanking", () => {
    expect(healthAlertLabel("ops.new_detector")).toBe("Ops.new detector");
    expect(healthAlertLabel("something_new")).toBe("Something new");
  });
});

describe("healthAlertEntityRef", () => {
  test("renders the pointer as type · id", () => {
    expect(
      healthAlertEntityRef({ entityType: "invoice", entityId: "inv_1" }),
    ).toBe("invoice · inv_1");
  });
});

describe("rail configuration pills", () => {
  test("configured rails are emerald, dark rails neutral slate", () => {
    expect(railConfiguredLabel(true)).toBe("Configured");
    expect(railConfiguredBadgeClasses(true)).toContain("emerald");
    expect(railConfiguredLabel(false)).toBe("Dark");
    expect(railConfiguredBadgeClasses(false)).toContain("slate");
  });

  test("key ids are named, the legacy single token is called out, secrets never appear", () => {
    expect(railKeyIdsLine({ keyIds: [], legacyTokenAccepted: true })).toBeNull();
    expect(railKeyIdsLine({ keyIds: ["legacy"], legacyTokenAccepted: true })).toBe(
      "Keys: legacy (single token) — plain x-op-token accepted",
    );
    expect(railKeyIdsLine({ keyIds: ["k1", "k2"], legacyTokenAccepted: false })).toBe(
      "Keys: k1, k2 — signed requests only",
    );
  });
});

// R95: each rail row names the transport serving it and the provenance its
// stamps will carry; a rail the live transport does not serve says so in the
// line and wears a neutral pill instead of a breaker badge.
describe("railTransportLine", () => {
  test("the simulator on sandbox reads transport · environment", () => {
    expect(
      railTransportLine({
        transport: "simulator",
        environment: "sandbox",
        configured: true,
      }),
    ).toBe("simulator · sandbox");
  });

  test("a live HTTP rail names the http transport and the live environment", () => {
    expect(
      railTransportLine({ transport: "http", environment: "live", configured: true }),
    ).toBe("http · live");
  });

  test("an unserved rail appends · not configured", () => {
    expect(
      railTransportLine({
        transport: "http",
        environment: "sandbox",
        configured: false,
      }),
    ).toBe("http · sandbox · not configured");
  });

  test("a bound test transport passes its name through untouched", () => {
    expect(
      railTransportLine({
        transport: "scripted",
        environment: "sandbox",
        configured: true,
      }),
    ).toBe("scripted · sandbox");
  });

  test("the not-configured pill is the same neutral slate as a dark rail-config entry", () => {
    expect(RAIL_NOT_CONFIGURED_LABEL).toBe("Not configured");
    expect(railNotConfiguredBadgeClasses()).toContain("slate");
    expect(railNotConfiguredBadgeClasses()).toBe(railConfiguredBadgeClasses(false));
  });
});

describe("card copy", () => {
  test("the quiet-platform empty state says so in words", () => {
    expect(HEALTH_ALERTS_EMPTY).toBe(
      "No health alerts — the platform is quiet.",
    );
  });

  test("the rail-config intro promises presence-only — values never shown", () => {
    expect(RAIL_CONFIG_INTRO).toBe(
      "Which environment-lit rails this deployment has configured. Values are never shown.",
    );
  });
});
