import { test, expect, describe, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OperationalReadinessCheck } from "@workspace/api-client-react";
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
  railLastErrorLine,
  retryingLine,
  isParked,
  RETRYING_EMPTY,
  operationalEvidenceBadge,
  OperationalReadinessRow,
  ReleaseReadinessSection,
} from "./platform-ops";

const query = vi.hoisted(() => ({ readiness: vi.fn() }));
vi.mock("@workspace/api-client-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/api-client-react")>()),
  useGetReleaseReadiness: query.readiness,
}));

describe("operational proof", () => {
  const check: OperationalReadinessCheck = {
    key: "backup",
    label: "Database backup",
    status: "blocked",
    summary: "The latest run failed.",
    detail: {
      evidenceSource: "operational_heartbeats",
      evidenceState: "failed",
      lastSucceededAt: "2026-09-04T10:00:00.000Z",
      lastFailedAt: "2026-09-04T11:00:00.000Z",
      owner: "Database operations",
      remediation: "Inspect the approved private runner.",
      offBoxRetentionVerified: false,
      lastError: "private-error",
      metadata: { secret: "private-secret" },
    },
  };
  test("missing, stale, failed and configuration evidence have distinct badges", () => {
    const states = [
      "missing",
      "stale",
      "failed",
      "invalid",
      "unverified",
      "current",
      "configuration_only",
    ];
    const labels = states.map(
      (evidenceState) =>
        operationalEvidenceBadge({ ...check, detail: { evidenceState } }).label,
    );
    expect(new Set(labels).size).toBe(states.length);
    const configured = operationalEvidenceBadge({
      ...check,
      status: "pass",
      detail: { evidenceState: "configuration_only" },
    });
    expect(configured.label).toBe("Configured only");
    expect(configured.classes).toContain("slate");
    expect(
      operationalEvidenceBadge({
        ...check,
        status: "pass",
        detail: {
          evidenceState: "current",
          evidenceSource: "operator_attestation",
        },
      }).label,
    ).toBe("Operator attestation");
  });
  test("rows render current timestamps, owner and next action without arbitrary evidence", () => {
    const html = renderToStaticMarkup(
      createElement(OperationalReadinessRow, { check }),
    );
    expect(html).toContain('dateTime="2026-09-04T10:00:00.000Z"');
    expect(html).toContain('dateTime="2026-09-04T11:00:00.000Z"');
    expect(html).toContain("Run failed");
    expect(html).toContain("Owner: Database operations");
    expect(html).toContain("Next action: Inspect the approved private runner.");
    expect(html).toContain("Private off-box retention: not verified");
    expect(html).not.toMatch(/private-error|private-secret/);
  });
  test("missing timestamps never render as a successful run", () => {
    const html = renderToStaticMarkup(
      createElement(OperationalReadinessRow, {
        check: {
          ...check,
          detail: {
            evidenceState: "missing",
            evidenceSource: "operational_heartbeats",
            lastSucceededAt: "invalid",
          },
        },
      }),
    );
    expect(html).toContain("Never recorded");
    expect(html).toContain("Evidence missing");
    expect(html).not.toContain("<time");
  });
  test("older server details retain the established readiness badge", () => {
    expect(operationalEvidenceBadge({ ...check, detail: null }).label).toBe(
      "Blocked",
    );
  });
  test("a failed refresh cannot keep a cached Ready badge or expose a raw error", () => {
    query.readiness.mockReturnValue({
      data: { status: "ready", checks: [check] },
      isLoading: false,
      error: new Error("private-response-detail"),
      refetch: vi.fn(),
      isFetching: false,
    });
    const html = renderToStaticMarkup(createElement(ReleaseReadinessSection));
    expect(html).toContain("Evidence unavailable");
    expect(html).toContain("Unable to load release readiness.");
    expect(html).not.toMatch(
      />Ready<|private-response-detail|release-check-backup/,
    );
  });
});

// Helpers behind the two operator observability cards. The action-label map
// is a MIRROR of the alert actions the server-side sweeps write to the audit
// ledger — the pin below fails if either side drifts, so a known alert can
// never silently degrade to a raw dotted action string.

describe("HEALTH_ALERT_ACTION_LABELS", () => {
  test("covers exactly the eight known alert actions with their words", () => {
    expect(HEALTH_ALERT_ACTION_LABELS).toEqual({
      "ops.rail.circuit_open": "Submission service paused after failures",
      "ops.outbox.dead": "Event stopped after repeated failures",
      "ops.sweep.pass_abandoned": "Background check stopped before completion",
      "ops.webhook.delivery_dead": "Webhook delivery stopped after failures",
      "clerk.spend.anomaly": "Unusual firm spending",
      "clerk.quality.drop": "Extraction quality drop",
      "clerk.injection_resistance.dropped": "Injection resistance drop",
      "clerk.reconcile_agreement.drop": "Reconciliation agreement drop",
    });
  });
});

describe("healthAlertLabel", () => {
  test("known actions resolve through the map", () => {
    expect(healthAlertLabel("ops.rail.circuit_open")).toBe(
      "Submission service paused after failures",
    );
    expect(healthAlertLabel("clerk.spend.anomaly")).toBe(
      "Unusual firm spending",
    );
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
    expect(railConfiguredLabel(false)).toBe("Not configured");
    expect(railConfiguredBadgeClasses(false)).toContain("slate");
  });

  test("key ids are named, the legacy single token is called out, secrets never appear", () => {
    expect(
      railKeyIdsLine({ keyIds: [], legacyTokenAccepted: true }),
    ).toBeNull();
    expect(
      railKeyIdsLine({ keyIds: ["legacy"], legacyTokenAccepted: true }),
    ).toBe("Keys: legacy (single token) — plain x-op-token accepted");
    expect(
      railKeyIdsLine({ keyIds: ["k1", "k2"], legacyTokenAccepted: false }),
    ).toBe("Keys: k1, k2 — signed requests only");
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
      railTransportLine({
        transport: "http",
        environment: "live",
        configured: true,
      }),
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
    expect(railNotConfiguredBadgeClasses()).toBe(
      railConfiguredBadgeClasses(false),
    );
  });
});

describe("card copy", () => {
  test("the quiet-platform empty state says so in words", () => {
    expect(HEALTH_ALERTS_EMPTY).toBe("No platform health alerts are recorded.");
  });

  test("the rail-config intro promises presence-only — values never shown", () => {
    expect(RAIL_CONFIG_INTRO).toBe(
      "Services with configuration present in this deployment. Credentials are never shown. Configuration alone does not prove a service is working.",
    );
  });
});

describe("rail last error and retrying lines (R102)", () => {
  test("the rails card names the failure class, and explains a refused credential", () => {
    expect(railLastErrorLine("RAIL_TIMEOUT")).toBe("last error RAIL_TIMEOUT");
    expect(railLastErrorLine("RAIL_UNAUTHORIZED")).toContain(
      "refuses our token",
    );
  });

  test("a retrying row says its tries and next try; a parked row says so with its wake time", () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    const later = new Date("2026-09-03T10:05:00.000Z").toISOString();
    expect(
      retryingLine(
        {
          attempts: 2,
          maxAttempts: 6,
          nextAttemptAt: later,
          parkedUntil: null,
          parkCount: 0,
        },
        now,
      ),
    ).toMatch(/^2\/6 attempts · next try /);
    expect(
      retryingLine(
        {
          attempts: 0,
          maxAttempts: 6,
          nextAttemptAt: later,
          parkedUntil: later,
          parkCount: 3,
        },
        now,
      ),
    ).toMatch(
      /^0\/6 attempts · paused while the submission service recovers \(3 pauses\) · resumes /,
    );
    expect(
      retryingLine(
        {
          attempts: 1,
          maxAttempts: 6,
          nextAttemptAt: null,
          parkedUntil: null,
          parkCount: 0,
        },
        now,
      ),
    ).toBe("1/6 attempts");
  });

  test("isParked reads a parkedUntil still in the future; a passed one is a plain retry", () => {
    const now = new Date("2026-09-03T10:00:00.000Z");
    expect(isParked({ parkedUntil: "2026-09-03T10:01:00.000Z" }, now)).toBe(
      true,
    );
    expect(isParked({ parkedUntil: "2026-09-03T09:59:00.000Z" }, now)).toBe(
      false,
    );
    expect(isParked({ parkedUntil: null }, now)).toBe(false);
    expect(RETRYING_EMPTY).toMatch(/Nothing retrying/);
  });
});
