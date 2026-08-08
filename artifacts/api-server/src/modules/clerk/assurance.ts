import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { GROUNDING_VIOLATION_ACTION } from "./grounding";
import { QUALITY_DROP_ACTION } from "./quality-watch";
import { RESISTANCE_DROP_ACTION } from "./resistance-watch";
import { SPEND_ANOMALY_ACTION } from "./spend-watch";

type GuardrailStatus = "healthy" | "watch" | "critical";

function number(value: unknown): number {
  return Number(value ?? 0);
}

function rate(part: number, whole: number): number {
  return whole > 0 ? Number((part / whole).toFixed(4)) : 0;
}

export function qualityStatus(
  value: number | null,
  healthyAt: number,
  criticalBelow: number,
): GuardrailStatus {
  if (value === null) return "watch";
  if (value >= healthyAt) return "healthy";
  if (value < criticalBelow) return "critical";
  return "watch";
}

export function failureRateStatus(
  value: number,
  sampleCount: number,
): GuardrailStatus {
  if (sampleCount === 0) return "watch";
  if (value <= 0.02) return "healthy";
  if (value >= 0.05) return "critical";
  return "watch";
}

export async function getClerkAssuranceWorkspace() {
  const db = getDb();
  const inferenceResult = await db.execute(sql`
    SELECT
      count(*)::int AS calls,
      count(*) FILTER (WHERE outcome = 'invalid_discarded')::int AS invalid,
      count(*) FILTER (WHERE outcome = 'error')::int AS errors,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
        FILTER (WHERE latency_ms IS NOT NULL) AS latency_p95_ms,
      coalesce(sum(prompt_tokens), 0)::int +
        coalesce(sum(completion_tokens), 0)::int AS tokens
    FROM clerk_inference_calls
    WHERE created_at > now() - interval '30 days'
  `);
  const caseResult = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE status IN ('pending', 'extracted', 'in_review', 'escalated')
      )::int AS pending_review,
      count(*) FILTER (
        WHERE status IN ('approved', 'rejected')
          AND updated_at > now() - interval '30 days'
      )::int AS decided_30d
    FROM clerk_cases
  `);
  const evalResult = await db.execute(sql`
    SELECT
      CASE WHEN fields_compared > 0
        THEN fields_correct::numeric / fields_compared
        ELSE NULL
      END AS accuracy,
      CASE WHEN injection_fixtures > 0
        THEN injection_resisted::numeric / injection_fixtures
        ELSE NULL
      END AS injection_resistance,
      created_at
    FROM clerk_eval_runs
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const auditResult = await db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE action = ${GROUNDING_VIOLATION_ACTION}
          AND created_at > now() - interval '30 days'
      )::int AS grounding_violations,
      count(*) FILTER (
        WHERE action IN (
          ${QUALITY_DROP_ACTION},
          ${RESISTANCE_DROP_ACTION},
          ${SPEND_ANOMALY_ACTION}
        )
          AND created_at > now() - interval '30 days'
      )::int AS governance_alerts
    FROM audit_events
  `);
  const flagResult = await db.execute(sql`
    SELECT key, enabled
    FROM feature_flags
    WHERE key IN (
      'clerk_ai',
      'clerk_actions',
      'clerk_action_policies',
      'clerk_auto_reconcile'
    )
  `);

  const inference = (inferenceResult.rows[0] ?? {}) as Record<string, unknown>;
  const cases = (caseResult.rows[0] ?? {}) as Record<string, unknown>;
  const evaluation = (evalResult.rows[0] ?? {}) as Record<string, unknown>;
  const audit = (auditResult.rows[0] ?? {}) as Record<string, unknown>;
  const calls30d = number(inference.calls);
  const invalidRate30d = rate(number(inference.invalid), calls30d);
  const errorRate30d = rate(number(inference.errors), calls30d);
  const latestEvalAccuracy =
    evaluation.accuracy === null || evaluation.accuracy === undefined
      ? null
      : Number(Number(evaluation.accuracy).toFixed(4));
  const latestInjectionResistance =
    evaluation.injection_resistance === null ||
    evaluation.injection_resistance === undefined
      ? null
      : Number(Number(evaluation.injection_resistance).toFixed(4));
  const evalCreatedAt =
    evaluation.created_at === null || evaluation.created_at === undefined
      ? null
      : new Date(evaluation.created_at as string | number | Date);
  const evalIsFresh =
    evalCreatedAt !== null &&
    Date.now() - evalCreatedAt.getTime() <= 30 * 24 * 60 * 60 * 1000;
  const groundingViolations30d = number(audit.grounding_violations);
  const governanceAlerts = number(audit.governance_alerts);
  const flags = new Map(
    flagResult.rows.map((raw) => {
      const row = raw as { key: string; enabled: boolean };
      return [row.key, row.enabled] as const;
    }),
  );
  const standingAutomationEnabled =
    flags.get("clerk_action_policies") === true ||
    flags.get("clerk_auto_reconcile") === true;
  const providerConfigured = Boolean(
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY &&
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  );

  const invalidStatus = failureRateStatus(invalidRate30d, calls30d);
  const errorStatus = failureRateStatus(errorRate30d, calls30d);
  const latencyP95Ms =
    inference.latency_p95_ms === null || inference.latency_p95_ms === undefined
      ? null
      : Math.round(number(inference.latency_p95_ms));
  const latencyStatus: GuardrailStatus =
    latencyP95Ms === null
      ? "watch"
      : latencyP95Ms <= 3_000
        ? "healthy"
        : latencyP95Ms >= 5_000
          ? "critical"
          : "watch";

  return {
    generatedAt: new Date().toISOString(),
    calls30d,
    pendingReview: number(cases.pending_review),
    decidedCases30d: number(cases.decided_30d),
    invalidRate30d,
    errorRate30d,
    latencyP95Ms,
    tokens30d: number(inference.tokens),
    latestEvalAccuracy,
    latestInjectionResistance,
    groundingViolations30d,
    guardrails: [
      {
        key: "human_review",
        label: "Human decision boundary",
        status: "healthy" as const,
        detail: `${number(cases.pending_review)} cases await review; approvals and rejections require a recorded human actor.`,
        actionHref: "/clerk",
      },
      {
        key: "schema_validity",
        label: "Typed-output validity",
        status: invalidStatus,
        detail:
          calls30d === 0
            ? "No model calls are available to establish output validity."
            : `${Math.round(invalidRate30d * 1000) / 10}% of model calls were discarded as schema-invalid in 30 days.`,
        actionHref: "/clerk/health",
      },
      {
        key: "runtime_errors",
        label: "Inference runtime reliability",
        status: errorStatus,
        detail:
          calls30d === 0
            ? "No model calls are available to establish runtime reliability."
            : `${Math.round(errorRate30d * 1000) / 10}% of model calls ended in provider or gateway errors.`,
        actionHref: "/clerk/health",
      },
      {
        key: "latency",
        label: "Inference latency envelope",
        status: latencyStatus,
        detail:
          latencyP95Ms === null
            ? "No measured inference latency is available in the 30-day window."
            : `Provider latency p95 is ${latencyP95Ms}ms over the 30-day window.`,
        actionHref: "/clerk/health",
      },
      {
        key: "eval_accuracy",
        label: "Extraction regression gate",
        status: evalIsFresh
          ? qualityStatus(latestEvalAccuracy, 0.95, 0.8)
          : ("watch" as const),
        detail:
          latestEvalAccuracy === null
            ? "No completed extraction evaluation run is available."
            : !evalIsFresh
              ? `Latest extraction evaluation is older than 30 days (${evalCreatedAt?.toISOString().slice(0, 10)}).`
              : `Latest fixed-corpus field accuracy is ${Math.round(latestEvalAccuracy * 1000) / 10}%.`,
        actionHref: "/clerk/health",
      },
      {
        key: "injection_resistance",
        label: "Prompt-injection resistance",
        status: evalIsFresh
          ? qualityStatus(latestInjectionResistance, 0.95, 0.8)
          : ("watch" as const),
        detail:
          latestInjectionResistance === null
            ? "No measured injection fixture run is available."
            : !evalIsFresh
              ? `Latest injection-resistance evaluation is older than 30 days (${evalCreatedAt?.toISOString().slice(0, 10)}).`
              : `Latest fixture resistance is ${Math.round(latestInjectionResistance * 1000) / 10}%.`,
        actionHref: "/clerk/health",
      },
      {
        key: "number_grounding",
        label: "Deterministic number grounding",
        status:
          calls30d === 0
            ? ("watch" as const)
            : groundingViolations30d === 0
              ? ("healthy" as const)
              : ("critical" as const),
        detail:
          calls30d === 0
            ? "No model calls are available to establish number-grounding performance."
            : groundingViolations30d === 0
              ? "No ungrounded numeral reached a phrasing surface in 30 days."
              : `${groundingViolations30d} outputs were replaced by deterministic templates.`,
        actionHref: "/clerk/health",
      },
      {
        key: "standing_automation",
        label: "Standing automation posture",
        status: standingAutomationEnabled
          ? ("watch" as const)
          : ("healthy" as const),
        detail: standingAutomationEnabled
          ? "A standing-action or auto-reconciliation flag is enabled; review policy scope and caps."
          : "Standing automation is dark; Clerk proposals remain on explicit human approval paths.",
        actionHref: "/feature-flags",
      },
      {
        key: "provider_configuration",
        label: "AI provider configuration",
        status: providerConfigured ? ("healthy" as const) : ("watch" as const),
        detail: providerConfigured
          ? "The managed AI base URL and credential are configured; values are never exposed."
          : "The managed AI integration is not fully configured in this deployment.",
        actionHref: "/platform-ops",
      },
      {
        key: "governance_alerts",
        label: "Quality, resistance and spend watches",
        status:
          governanceAlerts > 0 ? ("watch" as const) : ("healthy" as const),
        detail:
          governanceAlerts > 0
            ? `${governanceAlerts} durable governance alerts were raised in 30 days.`
            : "No quality-drop, resistance-drop or spend-anomaly alert was raised in 30 days.",
        actionHref: "/platform-ops",
      },
    ],
  };
}
