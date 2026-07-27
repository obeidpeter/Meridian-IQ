import { test, expect, describe } from "vitest";
import {
  HEALTH_ALERT_ACTION_LABELS,
  HEALTH_ALERTS_EMPTY,
  RAIL_CONFIG_INTRO,
  healthAlertLabel,
  healthAlertEntityRef,
  railConfiguredLabel,
  railConfiguredBadgeClasses,
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
