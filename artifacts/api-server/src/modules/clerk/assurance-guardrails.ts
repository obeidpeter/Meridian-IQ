import type { AssuranceSignals } from "./assurance-signals";
import { qualityStatus, type GuardrailStatus } from "./assurance-status";

// Clerk assurance — the guardrail phrasing (R126, split from assurance.ts):
// the ten guardrails the console's assurance page renders, built from the
// derived signals in the original order. Keys, labels, detail copy and
// actionHref values are pinned by assurance-guardrails.test.ts. No DB.

export interface AssuranceGuardrail {
  key: string;
  label: string;
  status: GuardrailStatus;
  detail: string;
  actionHref: string;
}

function reliabilityGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    {
      key: "human_review",
      label: "Human decision boundary",
      status: "healthy" as const,
      detail: `${s.pendingReview} cases await review; approvals and rejections require a recorded human actor.`,
      actionHref: "/clerk",
    },
    {
      key: "schema_validity",
      label: "Typed-output validity",
      status: s.invalidStatus,
      detail:
        s.calls30d === 0
          ? "No model calls are available to establish output validity."
          : `${Math.round(s.invalidRate30d * 1000) / 10}% of model calls were discarded as schema-invalid in 30 days.`,
      actionHref: "/clerk/health",
    },
    {
      key: "runtime_errors",
      label: "Inference runtime reliability",
      status: s.errorStatus,
      detail:
        s.calls30d === 0
          ? "No model calls are available to establish runtime reliability."
          : `${Math.round(s.errorRate30d * 1000) / 10}% of model calls ended in provider or gateway errors.`,
      actionHref: "/clerk/health",
    },
    {
      key: "latency",
      label: "Inference latency envelope",
      status: s.latencyStatus,
      detail:
        s.latencyP95Ms === null
          ? "No measured inference latency is available in the 30-day window."
          : `Provider latency p95 is ${s.latencyP95Ms}ms over the 30-day window.`,
      actionHref: "/clerk/health",
    },
  ];
}

function evaluationGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    {
      key: "eval_accuracy",
      label: "Extraction regression gate",
      status: s.evalIsFresh
        ? qualityStatus(s.latestEvalAccuracy, 0.95, 0.8)
        : ("watch" as const),
      detail:
        s.latestEvalAccuracy === null
          ? "No completed extraction evaluation run is available."
          : !s.evalIsFresh
            ? `Latest extraction evaluation is older than 30 days (${s.evalCreatedAt?.toISOString().slice(0, 10)}).`
            : `Latest fixed-corpus field accuracy is ${Math.round(s.latestEvalAccuracy * 1000) / 10}%.`,
      actionHref: "/clerk/health",
    },
    {
      key: "injection_resistance",
      label: "Prompt-injection resistance",
      status: s.evalIsFresh
        ? qualityStatus(s.latestInjectionResistance, 0.95, 0.8)
        : ("watch" as const),
      detail:
        s.latestInjectionResistance === null
          ? "No measured injection fixture run is available."
          : !s.evalIsFresh
            ? `Latest injection-resistance evaluation is older than 30 days (${s.evalCreatedAt?.toISOString().slice(0, 10)}).`
            : `Latest fixture resistance is ${Math.round(s.latestInjectionResistance * 1000) / 10}%.`,
      actionHref: "/clerk/health",
    },
  ];
}

function postureGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    {
      key: "number_grounding",
      label: "Deterministic number grounding",
      status:
        s.calls30d === 0
          ? ("watch" as const)
          : s.groundingViolations30d === 0
            ? ("healthy" as const)
            : ("critical" as const),
      detail:
        s.calls30d === 0
          ? "No model calls are available to establish number-grounding performance."
          : s.groundingViolations30d === 0
            ? "No ungrounded numeral reached a phrasing surface in 30 days."
            : `${s.groundingViolations30d} outputs were replaced by deterministic templates.`,
      actionHref: "/clerk/health",
    },
    {
      key: "standing_automation",
      label: "Standing automation posture",
      status: s.standingAutomationEnabled
        ? ("watch" as const)
        : ("healthy" as const),
      detail: s.standingAutomationEnabled
        ? "A standing-action or auto-reconciliation flag is enabled; review policy scope and caps."
        : "Standing automation is dark; Clerk proposals remain on explicit human approval paths.",
      actionHref: "/feature-flags",
    },
    {
      key: "provider_configuration",
      label: "AI provider configuration",
      status: s.providerConfigured ? ("healthy" as const) : ("watch" as const),
      detail: s.providerConfigured
        ? "The managed AI base URL and credential are configured; values are never exposed."
        : "The managed AI integration is not fully configured in this deployment.",
      actionHref: "/platform-ops",
    },
    {
      key: "governance_alerts",
      label: "Quality, resistance and spend watches",
      status:
        s.governanceAlerts > 0 ? ("watch" as const) : ("healthy" as const),
      detail:
        s.governanceAlerts > 0
          ? `${s.governanceAlerts} durable governance alerts were raised in 30 days.`
          : "No quality-drop, resistance-drop or spend-anomaly alert was raised in 30 days.",
      actionHref: "/platform-ops",
    },
  ];
}

export function buildGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    ...reliabilityGuardrails(s),
    ...evaluationGuardrails(s),
    ...postureGuardrails(s),
  ];
}
