import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Firm-wide automation rollup (round 33). The per-client effectiveness
// report (action-effectiveness.ts) answers "did automation help THIS
// client"; this answers the firm question — how much standing automation is
// in force, what paused and why, and what the last 30 days actually ran.
// Pure ledger SQL over the two policy tables, the plan runs and the
// decisions ledger; zero model calls; the operator acts on it from the
// per-client surfaces.

export interface AutomationRollup {
  actionPolicies: { live: number; paused: Record<string, number> };
  planPolicies: { live: number; paused: Record<string, number> };
  runs30d: { total: number; done: number; halted: number };
  decisions30d: {
    total: number;
    auto: number;
    executed: number;
    failed: number;
  };
}

interface PolicyRow extends Record<string, unknown> {
  paused_reason: string | null;
  n: number;
}

function foldPolicies(rows: PolicyRow[]): {
  live: number;
  paused: Record<string, number>;
} {
  let live = 0;
  const paused: Record<string, number> = {};
  for (const r of rows) {
    if (r.paused_reason === null) live += Number(r.n);
    else paused[r.paused_reason] = (paused[r.paused_reason] ?? 0) + Number(r.n);
  }
  return { live, paused };
}

export async function computeAutomationRollup(
  firmId: string,
): Promise<AutomationRollup> {
  const db = getDb();
  const actionRows = (
    await db.execute<PolicyRow>(sql`
      SELECT paused_reason, COUNT(*)::int AS n
      FROM clerk_action_policies
      WHERE firm_id = ${firmId} AND revoked_at IS NULL
      GROUP BY paused_reason`)
  ).rows;
  const planRows = (
    await db.execute<PolicyRow>(sql`
      SELECT paused_reason, COUNT(*)::int AS n
      FROM clerk_plan_policies
      WHERE firm_id = ${firmId} AND revoked_at IS NULL
      GROUP BY paused_reason`)
  ).rows;
  const [runs] = (
    await db.execute<{ total: number; done: number; halted: number }>(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'done')::int AS done,
             COUNT(*) FILTER (WHERE status = 'halted')::int AS halted
      FROM clerk_plan_runs
      WHERE firm_id = ${firmId}
        AND created_at >= now() - interval '30 days'`)
  ).rows;
  const [decisions] = (
    await db.execute<{
      total: number;
      auto: number;
      executed: number;
      failed: number;
    }>(sql`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (
               WHERE policy_id IS NOT NULL OR plan_run_id IS NOT NULL
             )::int AS auto,
             COALESCE(SUM(executed_count), 0)::int AS executed,
             COALESCE(SUM(failed_count), 0)::int AS failed
      FROM clerk_action_decisions
      WHERE firm_id = ${firmId}
        AND created_at >= now() - interval '30 days'`)
  ).rows;
  return {
    actionPolicies: foldPolicies(actionRows),
    planPolicies: foldPolicies(planRows),
    runs30d: {
      total: Number(runs?.total ?? 0),
      done: Number(runs?.done ?? 0),
      halted: Number(runs?.halted ?? 0),
    },
    decisions30d: {
      total: Number(decisions?.total ?? 0),
      auto: Number(decisions?.auto ?? 0),
      executed: Number(decisions?.executed ?? 0),
      failed: Number(decisions?.failed ?? 0),
    },
  };
}
