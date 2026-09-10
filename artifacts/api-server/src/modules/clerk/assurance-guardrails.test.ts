import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGuardrails } from "./assurance-guardrails.ts";
import {
  deriveAssuranceSignals,
  type AssuranceSignals,
} from "./assurance-signals.ts";

// The ten assurance guardrails the console renders (R126): no DB-backed test
// calls getClerkAssuranceWorkspace and the route's zod parse only checks
// shape, so the key/label/status/detail/actionHref copy is pinned here
// literally, from fixed signals — a transposed sentence fails here instead
// of shipping silently.

const cold: AssuranceSignals = {
  calls30d: 0,
  pendingReview: 3,
  decidedCases30d: 0,
  invalidRate30d: 0,
  errorRate30d: 0,
  invalidStatus: "watch",
  errorStatus: "watch",
  latencyP95Ms: null,
  latencyStatus: "watch",
  tokens30d: 0,
  latestEvalAccuracy: null,
  latestInjectionResistance: null,
  evalCreatedAt: null,
  evalIsFresh: false,
  groundingViolations30d: 0,
  governanceAlerts: 0,
  standingAutomationEnabled: false,
  providerConfigured: false,
};

test("guardrails: a cold deployment (no calls, no eval, nothing configured) phrases every entry as unmeasured", () => {
  assert.deepEqual(buildGuardrails(cold), [
    {
      key: "human_review",
      label: "Human decision boundary",
      status: "healthy",
      detail:
        "3 cases await review; approvals and rejections require a recorded human actor.",
      actionHref: "/clerk",
    },
    {
      key: "schema_validity",
      label: "Typed-output validity",
      status: "watch",
      detail: "No model calls are available to establish output validity.",
      actionHref: "/clerk/health",
    },
    {
      key: "runtime_errors",
      label: "Inference runtime reliability",
      status: "watch",
      detail: "No model calls are available to establish runtime reliability.",
      actionHref: "/clerk/health",
    },
    {
      key: "latency",
      label: "Inference latency envelope",
      status: "watch",
      detail:
        "No measured inference latency is available in the 30-day window.",
      actionHref: "/clerk/health",
    },
    {
      key: "eval_accuracy",
      label: "Extraction regression gate",
      status: "watch",
      detail: "No completed extraction evaluation run is available.",
      actionHref: "/clerk/health",
    },
    {
      key: "injection_resistance",
      label: "Prompt-injection resistance",
      status: "watch",
      detail: "No measured injection fixture run is available.",
      actionHref: "/clerk/health",
    },
    {
      key: "number_grounding",
      label: "Deterministic number grounding",
      status: "watch",
      detail:
        "No model calls are available to establish number-grounding performance.",
      actionHref: "/clerk/health",
    },
    {
      key: "standing_automation",
      label: "Standing automation posture",
      status: "healthy",
      detail:
        "Standing automation is dark; Clerk proposals remain on explicit human approval paths.",
      actionHref: "/feature-flags",
    },
    {
      key: "provider_configuration",
      label: "AI provider configuration",
      status: "watch",
      detail:
        "The managed AI integration is not fully configured in this deployment.",
      actionHref: "/platform-ops",
    },
    {
      key: "governance_alerts",
      label: "Quality, resistance and spend watches",
      status: "healthy",
      detail:
        "No quality-drop, resistance-drop or spend-anomaly alert was raised in 30 days.",
      actionHref: "/platform-ops",
    },
  ]);
});

test("guardrails: a fresh, healthy deployment prices every rate to one decimal and reads the fresh eval", () => {
  const healthy: AssuranceSignals = {
    ...cold,
    calls30d: 400,
    pendingReview: 12,
    decidedCases30d: 90,
    invalidRate30d: 0.012,
    errorRate30d: 0.004,
    invalidStatus: "healthy",
    errorStatus: "healthy",
    latencyP95Ms: 2100,
    latencyStatus: "healthy",
    tokens30d: 120_000,
    latestEvalAccuracy: 0.9712,
    latestInjectionResistance: 0.96,
    evalCreatedAt: new Date("2026-09-01T10:00:00Z"),
    evalIsFresh: true,
    providerConfigured: true,
  };
  const rails = buildGuardrails(healthy);
  assert.deepEqual(
    rails.map((g) => [g.key, g.status, g.detail]),
    [
      [
        "human_review",
        "healthy",
        "12 cases await review; approvals and rejections require a recorded human actor.",
      ],
      [
        "schema_validity",
        "healthy",
        "1.2% of model calls were discarded as schema-invalid in 30 days.",
      ],
      [
        "runtime_errors",
        "healthy",
        "0.4% of model calls ended in provider or gateway errors.",
      ],
      [
        "latency",
        "healthy",
        "Provider latency p95 is 2100ms over the 30-day window.",
      ],
      [
        "eval_accuracy",
        "healthy",
        "Latest fixed-corpus field accuracy is 97.1%.",
      ],
      ["injection_resistance", "healthy", "Latest fixture resistance is 96%."],
      [
        "number_grounding",
        "healthy",
        "No ungrounded numeral reached a phrasing surface in 30 days.",
      ],
      [
        "standing_automation",
        "healthy",
        "Standing automation is dark; Clerk proposals remain on explicit human approval paths.",
      ],
      [
        "provider_configuration",
        "healthy",
        "The managed AI base URL and credential are configured; values are never exposed.",
      ],
      [
        "governance_alerts",
        "healthy",
        "No quality-drop, resistance-drop or spend-anomaly alert was raised in 30 days.",
      ],
    ],
  );
  assert.deepEqual(
    rails.map((g) => g.actionHref),
    [
      "/clerk",
      "/clerk/health",
      "/clerk/health",
      "/clerk/health",
      "/clerk/health",
      "/clerk/health",
      "/clerk/health",
      "/feature-flags",
      "/platform-ops",
      "/platform-ops",
    ],
  );
});

test("guardrails: a stale eval, standing automation, alerts and grounding violations each turn their entry", () => {
  const degraded: AssuranceSignals = {
    ...cold,
    calls30d: 50,
    pendingReview: 0,
    invalidRate30d: 0.06,
    errorRate30d: 0.03,
    invalidStatus: "critical",
    errorStatus: "watch",
    latencyP95Ms: 5200,
    latencyStatus: "critical",
    // A measured eval that is too old to vouch for the prompt: status
    // watch regardless of the numbers, and the date shows in the detail.
    latestEvalAccuracy: 0.9,
    latestInjectionResistance: 0.7,
    evalCreatedAt: new Date("2026-07-15T08:30:00Z"),
    evalIsFresh: false,
    groundingViolations30d: 4,
    governanceAlerts: 2,
    standingAutomationEnabled: true,
    providerConfigured: false,
  };
  assert.deepEqual(
    buildGuardrails(degraded).map((g) => [g.key, g.status, g.detail]),
    [
      [
        "human_review",
        "healthy",
        "0 cases await review; approvals and rejections require a recorded human actor.",
      ],
      [
        "schema_validity",
        "critical",
        "6% of model calls were discarded as schema-invalid in 30 days.",
      ],
      [
        "runtime_errors",
        "watch",
        "3% of model calls ended in provider or gateway errors.",
      ],
      [
        "latency",
        "critical",
        "Provider latency p95 is 5200ms over the 30-day window.",
      ],
      [
        "eval_accuracy",
        "watch",
        "Latest extraction evaluation is older than 30 days (2026-07-15).",
      ],
      [
        "injection_resistance",
        "watch",
        "Latest injection-resistance evaluation is older than 30 days (2026-07-15).",
      ],
      [
        "number_grounding",
        "critical",
        "4 outputs were replaced by deterministic templates.",
      ],
      [
        "standing_automation",
        "watch",
        "A standing-action or auto-reconciliation flag is enabled; review policy scope and caps.",
      ],
      [
        "provider_configuration",
        "watch",
        "The managed AI integration is not fully configured in this deployment.",
      ],
      [
        "governance_alerts",
        "watch",
        "2 durable governance alerts were raised in 30 days.",
      ],
    ],
  );
});

test("guardrails: a fresh eval below the floor is critical, between the bands is watch", () => {
  const fresh = {
    ...cold,
    evalCreatedAt: new Date(),
    evalIsFresh: true,
  };
  const [accuracy] = buildGuardrails({
    ...fresh,
    latestEvalAccuracy: 0.79,
  }).filter((g) => g.key === "eval_accuracy");
  assert.equal(accuracy.status, "critical");
  assert.equal(accuracy.detail, "Latest fixed-corpus field accuracy is 79%.");
  const [resistance] = buildGuardrails({
    ...fresh,
    latestInjectionResistance: 0.9,
  }).filter((g) => g.key === "injection_resistance");
  assert.equal(resistance.status, "watch");
  assert.equal(resistance.detail, "Latest fixture resistance is 90%.");
});

test("signals: empty query results derive the cold posture; a populated row derives rates, statuses and the flag posture", () => {
  const savedKey = process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  const savedUrl = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  try {
    delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    const empty = deriveAssuranceSignals({
      inference: [],
      cases: [],
      evaluation: [],
      audit: [],
      flags: [],
    });
    assert.deepEqual(empty, { ...cold, pendingReview: 0 });

    process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "k";
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "https://ai.example";
    const createdAt = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const live = deriveAssuranceSignals({
      inference: [
        {
          calls: 200,
          invalid: "2",
          errors: 12,
          latency_p95_ms: "4100.6",
          tokens: 9_000,
        },
      ],
      cases: [{ pending_review: 5, decided_30d: 40 }],
      evaluation: [
        {
          accuracy: "0.97123456",
          injection_resistance: null,
          created_at: createdAt,
        },
      ],
      audit: [{ grounding_violations: 1, governance_alerts: 0 }],
      flags: [
        { key: "clerk_ai", enabled: true },
        { key: "clerk_auto_reconcile", enabled: true },
      ],
    });
    assert.equal(live.calls30d, 200);
    assert.equal(live.invalidRate30d, 0.01);
    assert.equal(live.invalidStatus, "healthy");
    assert.equal(live.errorRate30d, 0.06);
    assert.equal(live.errorStatus, "critical");
    assert.equal(live.latencyP95Ms, 4101);
    assert.equal(live.latencyStatus, "watch");
    assert.equal(live.tokens30d, 9_000);
    assert.equal(live.pendingReview, 5);
    assert.equal(live.decidedCases30d, 40);
    assert.equal(live.latestEvalAccuracy, 0.9712);
    assert.equal(live.latestInjectionResistance, null);
    assert.equal(live.evalCreatedAt?.getTime(), createdAt.getTime());
    assert.equal(live.evalIsFresh, true);
    assert.equal(live.groundingViolations30d, 1);
    assert.equal(live.governanceAlerts, 0);
    assert.equal(live.standingAutomationEnabled, true);
    assert.equal(live.providerConfigured, true);
  } finally {
    if (savedKey === undefined)
      delete process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
    else process.env.AI_INTEGRATIONS_OPENAI_API_KEY = savedKey;
    if (savedUrl === undefined)
      delete process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
    else process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = savedUrl;
  }
});
