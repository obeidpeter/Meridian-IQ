import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { AUTO_RECONCILE_FLAG_KEY, AUTO_RECONCILE_THRESHOLD } from "./plan-steps";
import {
  alertOnceViaAuditLedger,
  atMostHourly,
  envThreshold,
} from "./watch-shared";

// Prove with Clerk Phase 3: the agreement watch. Once a firm lights
// clerk_auto_reconcile, the autopilot accepts the ≥threshold receipt matches
// it captures — but humans keep deciding the overflow (the per-run cap) and
// everything the cap leaves behind, so the firm's HUMAN verdicts on
// ≥threshold proposals remain a live measurement of whether the bar still
// deserves its trust. A month-over-month collapse in that agreement rate
// means the matcher and this firm's bank reality have drifted apart — an
// operator should reconsider the firm's flag. Like every watch, this one
// takes NO automatic action: no sweep anywhere writes a feature flag, and a
// drift needs a human judgement, not a kill switch.
//
// The monthly buckets carry the automation-evidence predicates in lockstep
// (automation-evidence.ts reconcileEvidence): credit lines only, the
// top-of-line guard, machine acceptances excluded via the plan-step audit
// pointer, and the outranked-superseded disagreement leg — so the evidence
// card and this alert can never tell different stories about the same firm.

export const RECONCILE_AGREEMENT_DROP_ACTION = "clerk.reconcile_agreement.drop";

const MIN_DECISIONS = envThreshold(
  process.env.AGREEMENT_ALERT_MIN_DECISIONS,
  10,
);
const DROP_POINTS = envThreshold(process.env.AGREEMENT_ALERT_DROP_POINTS, 0.2);

export interface AgreementMonth {
  month: string; // "YYYY-MM"
  agreed: number;
  disagreed: number;
  rate: number; // agreed / (agreed + disagreed), 4dp
}

interface MonthRow extends Record<string, unknown> {
  month: string;
  agreed: number;
  disagreed: number;
}

// One firm's human verdicts on ≥threshold receipt proposals, bucketed by
// decision month. Explicit AT TIME ZONE 'UTC': bare date_trunc on a
// timestamptz follows the SESSION timezone (the quality-watch rule).
export async function reconcileAgreementMonths(
  firmId: string,
  monthsBack = 5,
): Promise<AgreementMonth[]> {
  const db = getDb();
  const decided = (
    await db.execute<MonthRow>(sql`
      SELECT
        to_char(date_trunc('month', mp.decided_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
        COUNT(*) FILTER (WHERE mp.status = 'accepted')::int AS agreed,
        COUNT(*) FILTER (WHERE mp.status = 'rejected')::int AS disagreed
      FROM match_proposals mp
      JOIN bank_statement_lines l ON l.id = mp.statement_line_id
      WHERE mp.firm_id = ${firmId}
        AND l.direction = 'credit'
        AND mp.confidence >= ${AUTO_RECONCILE_THRESHOLD}
        AND mp.status IN ('accepted', 'rejected')
        AND mp.decided_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
          - ${monthsBack}::int * interval '1 month'
        AND NOT EXISTS (
          SELECT 1 FROM match_proposals s
          WHERE s.statement_line_id = mp.statement_line_id
            AND s.id <> mp.id
            AND s.confidence > mp.confidence
            AND s.status <> 'rejected'
        )
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.action = 'clerk.plan_step.reconciled'
            AND a.after ->> 'proposalId' = mp.id::text
        )
      GROUP BY 1
    `)
  ).rows;
  const outranked = (
    await db.execute<MonthRow>(sql`
      SELECT
        to_char(date_trunc('month', acc.decided_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month,
        0::int AS agreed,
        COUNT(*)::int AS disagreed
      FROM match_proposals mp
      JOIN bank_statement_lines l ON l.id = mp.statement_line_id
      JOIN match_proposals acc
        ON acc.statement_line_id = mp.statement_line_id
       AND acc.status = 'accepted'
       AND acc.id <> mp.id
       AND acc.confidence < mp.confidence
      WHERE mp.firm_id = ${firmId}
        AND l.direction = 'credit'
        AND mp.confidence >= ${AUTO_RECONCILE_THRESHOLD}
        AND mp.status = 'superseded'
        AND acc.decided_at >= date_trunc('month', now() AT TIME ZONE 'UTC')
          - ${monthsBack}::int * interval '1 month'
        AND NOT EXISTS (
          SELECT 1 FROM audit_events a
          WHERE a.action = 'clerk.plan_step.reconciled'
            AND a.after ->> 'proposalId' = acc.id::text
        )
      GROUP BY 1
    `)
  ).rows;
  const byMonth = new Map<string, { agreed: number; disagreed: number }>();
  for (const r of [...decided, ...outranked]) {
    const cur = byMonth.get(r.month) ?? { agreed: 0, disagreed: 0 };
    cur.agreed += Number(r.agreed);
    cur.disagreed += Number(r.disagreed);
    byMonth.set(r.month, cur);
  }
  return [...byMonth.entries()]
    .map(([month, c]) => ({
      month,
      agreed: c.agreed,
      disagreed: c.disagreed,
      rate:
        c.agreed + c.disagreed === 0
          ? 0
          : Math.round((c.agreed / (c.agreed + c.disagreed)) * 10_000) / 10_000,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));
}

export interface AgreementDrop {
  fromMonth: string;
  toMonth: string;
  fromRate: number;
  toRate: number;
  decisions: number;
}

// Month-over-month, the quality-watch rule exactly: thin months are SKIPPED
// (not compared — a two-decision month proves nothing either way), the last
// two measured months carry the verdict, and the drop must clear the
// threshold in rate points.
export function detectAgreementDrop(
  months: AgreementMonth[],
  minDecisions = MIN_DECISIONS,
  dropPoints = DROP_POINTS,
): AgreementDrop | null {
  const measured = months.filter(
    (m) => m.agreed + m.disagreed >= minDecisions,
  );
  if (measured.length < 2) return null;
  const from = measured[measured.length - 2];
  const to = measured[measured.length - 1];
  if (from.rate - to.rate < dropPoints) return null;
  return {
    fromMonth: from.month,
    toMonth: to.month,
    fromRate: from.rate,
    toRate: to.rate,
    decisions: to.agreed + to.disagreed,
  };
}

export interface AgreementWatchDeps {
  litFirms(): Promise<string[]>;
  months(firmId: string): Promise<AgreementMonth[]>;
}

// Firms whose auto-reconcile is actually live — BOTH switches, the
// plan-steps rule (reconciliation gates every human surface; the autopilot
// opt-in layers on top). Enumeration is cross-firm, so it runs under the
// sweep's bypass context like every watch.
async function litFirms(): Promise<string[]> {
  const firms = (
    await getDb().execute<Record<string, unknown> & { id: string }>(
      sql`SELECT id FROM firms`,
    )
  ).rows;
  const lit: string[] = [];
  for (const f of firms) {
    if (
      (await isFeatureEnabled("reconciliation", f.id)) &&
      (await isFeatureEnabled(AUTO_RECONCILE_FLAG_KEY, f.id))
    ) {
      lit.push(f.id);
    }
  }
  return lit;
}

const realDeps: AgreementWatchDeps = {
  litFirms,
  months: (firmId) => reconcileAgreementMonths(firmId),
};

const alertAgreementDrop = alertOnceViaAuditLedger({
  action: RECONCILE_AGREEMENT_DROP_ACTION,
  entityType: "clerk_reconcile_agreement",
  actorId: "agreement-watch",
});

export interface AgreementWatchResult {
  checked: number;
  dropped: number;
  alerted: number;
}

export async function sweepAgreementWatch(
  deps: AgreementWatchDeps = realDeps,
): Promise<AgreementWatchResult> {
  return runInBypassContext(async () => {
    const result: AgreementWatchResult = { checked: 0, dropped: 0, alerted: 0 };
    for (const firmId of await deps.litFirms()) {
      result.checked += 1;
      const drop = detectAgreementDrop(await deps.months(firmId));
      if (!drop) continue;
      result.dropped += 1;
      // One alert per (firm, degraded month) — a re-run says nothing new.
      const appended = await alertAgreementDrop(
        `${firmId}:${drop.toMonth}`,
        {
          firmId,
          fromMonth: drop.fromMonth,
          toMonth: drop.toMonth,
          fromRate: drop.fromRate,
          toRate: drop.toRate,
          decisions: drop.decisions,
          reason:
            "Human agreement with high-confidence receipt matches collapsed month-over-month while auto-reconcile is live — reconsider this firm's clerk_auto_reconcile flag.",
        },
        "reconcile agreement drop: a live auto-reconcile firm's human verdicts turned against the matcher — review the firm's flag",
        { firmId },
      );
      if (appended) result.alerted += 1;
    }
    return result;
  });
}

registerSweep(atMostHourly(sweepAgreementWatch));
