import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { GROUNDING_VIOLATION_ACTION } from "./grounding";
import { QUALITY_DROP_ACTION } from "./quality-watch";
import { RESISTANCE_DROP_ACTION } from "./resistance-watch";
import { SPEND_ANOMALY_ACTION } from "./spend-watch";
import { deriveAssuranceSignals } from "./assurance-signals";
import { buildGuardrails } from "./assurance-guardrails";

// Clerk assurance workspace (the console's assurance page, GET
// /operator/clerk-assurance): five pure SQL reads over the ledger, the case
// table, the eval runs, the audit stream and the feature flags, folded into
// the headline numbers and ten guardrails. R126: the derivation lives in
// assurance-signals.ts and the phrasing in assurance-guardrails.ts (both
// DB-free); the status rules in assurance-status.ts are re-exported here so
// desk/control-centre keeps its import path.

export { qualityStatus, failureRateStatus } from "./assurance-status";

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

  const signals = deriveAssuranceSignals({
    inference: inferenceResult.rows,
    cases: caseResult.rows,
    evaluation: evalResult.rows,
    audit: auditResult.rows,
    flags: flagResult.rows,
  });

  return {
    generatedAt: new Date().toISOString(),
    calls30d: signals.calls30d,
    pendingReview: signals.pendingReview,
    decidedCases30d: signals.decidedCases30d,
    invalidRate30d: signals.invalidRate30d,
    errorRate30d: signals.errorRate30d,
    latencyP95Ms: signals.latencyP95Ms,
    tokens30d: signals.tokens30d,
    latestEvalAccuracy: signals.latestEvalAccuracy,
    latestInjectionResistance: signals.latestInjectionResistance,
    groundingViolations30d: signals.groundingViolations30d,
    guardrails: buildGuardrails(signals),
  };
}
