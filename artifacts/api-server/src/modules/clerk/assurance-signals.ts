import {
  failureRateStatus,
  number,
  rate,
  type GuardrailStatus,
} from "./assurance-status";

// Clerk assurance — signal derivation (R126, split from assurance.ts): the
// five query results become one typed bag of numbers and statuses the
// guardrail builder phrases. No @workspace/db import — this file stays
// loadable DB-free (assurance-guardrails.test.ts feeds fixed signals).

export interface AssuranceSignals {
  calls30d: number;
  pendingReview: number;
  decidedCases30d: number;
  invalidRate30d: number;
  errorRate30d: number;
  invalidStatus: GuardrailStatus;
  errorStatus: GuardrailStatus;
  latencyP95Ms: number | null;
  latencyStatus: GuardrailStatus;
  tokens30d: number;
  latestEvalAccuracy: number | null;
  latestInjectionResistance: number | null;
  evalCreatedAt: Date | null;
  evalIsFresh: boolean;
  groundingViolations30d: number;
  governanceAlerts: number;
  standingAutomationEnabled: boolean;
  providerConfigured: boolean;
}

// The five `db.execute` results' rows, in query order.
export interface AssuranceQueryRows {
  inference: Record<string, unknown>[];
  cases: Record<string, unknown>[];
  evaluation: Record<string, unknown>[];
  audit: Record<string, unknown>[];
  flags: Record<string, unknown>[];
}

// A nullable numeric ratio from the eval row, to four places — the one
// spelling for accuracy and injection resistance.
export function nullableFixed4(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : Number(Number(value).toFixed(4));
}

// The latest eval run's age gate: a run older than 30 days no longer
// vouches for the current prompt.
export function evalFreshness(createdAt: unknown): {
  evalCreatedAt: Date | null;
  evalIsFresh: boolean;
} {
  const evalCreatedAt =
    createdAt === null || createdAt === undefined
      ? null
      : new Date(createdAt as string | number | Date);
  const evalIsFresh =
    evalCreatedAt !== null &&
    Date.now() - evalCreatedAt.getTime() <= 30 * 24 * 60 * 60 * 1000;
  return { evalCreatedAt, evalIsFresh };
}

// The provider latency envelope: p95 rounded to whole ms, healthy to 3 s,
// critical from 5 s, watch between (or when nothing was measured).
export function latencyEnvelope(raw: unknown): {
  latencyP95Ms: number | null;
  latencyStatus: GuardrailStatus;
} {
  const latencyP95Ms =
    raw === null || raw === undefined ? null : Math.round(number(raw));
  const latencyStatus: GuardrailStatus =
    latencyP95Ms === null
      ? "watch"
      : latencyP95Ms <= 3_000
        ? "healthy"
        : latencyP95Ms >= 5_000
          ? "critical"
          : "watch";
  return { latencyP95Ms, latencyStatus };
}

// Standing-automation and provider posture. The provider env is read PER
// CALL (never cached), so a deployment change shows on the next read.
export function flagPosture(flagRows: Record<string, unknown>[]): {
  standingAutomationEnabled: boolean;
  providerConfigured: boolean;
} {
  const flags = new Map(
    flagRows.map((raw) => {
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
  return { standingAutomationEnabled, providerConfigured };
}

export function deriveAssuranceSignals(
  rows: AssuranceQueryRows,
): AssuranceSignals {
  const inference = (rows.inference[0] ?? {}) as Record<string, unknown>;
  const cases = (rows.cases[0] ?? {}) as Record<string, unknown>;
  const evaluation = (rows.evaluation[0] ?? {}) as Record<string, unknown>;
  const audit = (rows.audit[0] ?? {}) as Record<string, unknown>;
  const calls30d = number(inference.calls);
  const invalidRate30d = rate(number(inference.invalid), calls30d);
  const errorRate30d = rate(number(inference.errors), calls30d);
  const latestEvalAccuracy = nullableFixed4(evaluation.accuracy);
  const latestInjectionResistance = nullableFixed4(
    evaluation.injection_resistance,
  );
  const { evalCreatedAt, evalIsFresh } = evalFreshness(evaluation.created_at);
  const groundingViolations30d = number(audit.grounding_violations);
  const governanceAlerts = number(audit.governance_alerts);
  const { standingAutomationEnabled, providerConfigured } = flagPosture(
    rows.flags,
  );

  const invalidStatus = failureRateStatus(invalidRate30d, calls30d);
  const errorStatus = failureRateStatus(errorRate30d, calls30d);
  const { latencyP95Ms, latencyStatus } = latencyEnvelope(
    inference.latency_p95_ms,
  );

  return {
    calls30d,
    pendingReview: number(cases.pending_review),
    decidedCases30d: number(cases.decided_30d),
    invalidRate30d,
    errorRate30d,
    invalidStatus,
    errorStatus,
    latencyP95Ms,
    latencyStatus,
    tokens30d: number(inference.tokens),
    latestEvalAccuracy,
    latestInjectionResistance,
    evalCreatedAt,
    evalIsFresh,
    groundingViolations30d,
    governanceAlerts,
    standingAutomationEnabled,
    providerConfigured,
  };
}
