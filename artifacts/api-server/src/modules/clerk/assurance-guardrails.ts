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
      label: "Human approval required",
      status: "healthy" as const,
      detail: `${s.pendingReview} cases await review. Each approval or rejection records who made the decision.`,
      actionHref: "/clerk",
    },
    {
      key: "schema_validity",
      label: "AI response format checks",
      status: s.invalidStatus,
      detail:
        s.calls30d === 0
          ? "No AI responses are available to check yet."
          : `${Math.round(s.invalidRate30d * 1000) / 10}% of AI responses were discarded because they did not match the required format in the last 30 days.`,
      actionHref: "/clerk/health",
    },
    {
      key: "runtime_errors",
      label: "AI request reliability",
      status: s.errorStatus,
      detail:
        s.calls30d === 0
          ? "No AI requests are available to assess reliability yet."
          : `${Math.round(s.errorRate30d * 1000) / 10}% of AI requests failed at the provider or Valo gateway.`,
      actionHref: "/clerk/health",
    },
    {
      key: "latency",
      label: "AI response time",
      status: s.latencyStatus,
      detail:
        s.latencyP95Ms === null
          ? "No AI response times were measured in the last 30 days."
          : `95% of measured provider responses took ${s.latencyP95Ms}ms or less in the last 30 days (p95).`,
      actionHref: "/clerk/health",
    },
  ];
}

function evaluationGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    {
      key: "eval_accuracy",
      label: "Document-reading accuracy tests",
      status: s.evalIsFresh
        ? qualityStatus(s.latestEvalAccuracy, 0.95, 0.8)
        : ("watch" as const),
      detail:
        s.latestEvalAccuracy === null
          ? "No completed extraction evaluation run is available."
          : !s.evalIsFresh
            ? `Latest extraction evaluation is older than 30 days (${s.evalCreatedAt?.toISOString().slice(0, 10)}).`
            : `The latest test read ${Math.round(s.latestEvalAccuracy * 1000) / 10}% of fields correctly from the fixed document sample.`,
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
          ? "No prompt-injection test results are available."
          : !s.evalIsFresh
            ? `Latest injection-resistance evaluation is older than 30 days (${s.evalCreatedAt?.toISOString().slice(0, 10)}).`
            : `Clerk resisted ${Math.round(s.latestInjectionResistance * 1000) / 10}% of prompt-injection attempts in the latest test sample.`,
      actionHref: "/clerk/health",
    },
  ];
}

function postureGuardrails(s: AssuranceSignals): AssuranceGuardrail[] {
  return [
    {
      key: "number_grounding",
      label: "AI number checks",
      status:
        s.calls30d === 0
          ? ("watch" as const)
          : s.groundingViolations30d === 0
            ? ("healthy" as const)
            : ("critical" as const),
      detail:
        s.calls30d === 0
          ? "No AI requests are available to assess number checks yet."
          : s.groundingViolations30d === 0
            ? "No number-check fallbacks were recorded in the last 30 days."
            : `${s.groundingViolations30d} number-check fallbacks were recorded in the last 30 days.`,
      actionHref: "/clerk/health",
    },
    {
      key: "standing_automation",
      label: "Automatic actions",
      status: s.standingAutomationEnabled
        ? ("watch" as const)
        : ("healthy" as const),
      detail: s.standingAutomationEnabled
        ? "Automatic actions or payment matching are enabled. Review which records they can affect and the limits for each run."
        : "Automatic actions are off. Each Clerk proposal needs human approval.",
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
      label: "AI quality, safety and spending alerts",
      status:
        s.governanceAlerts > 0 ? ("watch" as const) : ("healthy" as const),
      detail:
        s.governanceAlerts > 0
          ? `${s.governanceAlerts} AI quality, safety or spending alerts were recorded in the last 30 days.`
          : "No alerts for lower accuracy, weaker prompt-injection resistance or unusual spending were recorded in the last 30 days.",
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
