import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { bandExposure } from "../invoice/penalty-exposure";

// Action effectiveness (round 29 — the accountability half of the
// proposed-actions arc, deferred since round 22). The decisions ledger says
// what a batch DID at approval time; this report says whether it WORKED:
// where the executed submissions stand now (stamped? failed again? still in
// flight?), how much of the window's work the autopilot carried versus
// fresh human clicks, and the s.104 exposure floor the submissions removed.
// Pure SQL over the firm's own decisions ledger joined back to the invoices
// the targets point at — zero model calls, computed on demand, nothing
// stored. Client-scoped like the actions surface itself (SEC-03: the route
// resolves the client through resolveClientAnalyticsScope).
//
// Honesty notes, same discipline as the proposal copy:
//  - "executed" is the decision-time tally (submitted/drafted outcomes);
//    the NOW columns re-read each executed submit target's current invoice
//    status, so a retry that failed again is visible, not buried;
//  - the exposure figure is the LOWEST turnover band over the window's
//    executed submit_overdue count MINUS the failed-again ones (an invoice
//    the rails later rejected is back in penalty territory — its exposure
//    was not removed) — an estimate under the published penalty model,
//    never advice;
//  - chaser drafts count as executed work but have no rail outcome to
//    verify here — reminder effectiveness (chase-effectiveness.ts) already
//    audits whether chasing correlates with settlement.

const EFFECTIVENESS_DEFAULT_WINDOW_DAYS = 90;

export interface ActionEffectivenessKindRow {
  kind: string;
  decisions: number;
  // Of which ran under a standing approval (policyId set).
  autoDecisions: number;
  requested: number;
  executed: number;
  skipped: number;
  failed: number;
  // Current invoice status of the EXECUTED submit targets (null for
  // draft_chasers — drafted text has no rail lifecycle to re-read).
  nowSucceeded: number | null;
  nowInFlight: number | null;
  nowFailedAgain: number | null;
  nowOther: number | null;
}

export interface ActionEffectivenessReport {
  windowDays: number;
  totals: {
    decisions: number;
    autoDecisions: number;
    executed: number;
    failed: number;
  };
  // Lowest-band s.104 exposure estimate removed by the window's executed
  // submit_overdue targets, in whole naira ("0" when none).
  exposureFloorClearedNgn: string;
  kinds: ActionEffectivenessKindRow[];
}

const SUBMIT_KINDS = ["submit_overdue", "retry_failed"] as const;

export async function computeActionEffectiveness(
  firmId: string,
  clientPartyId: string,
  windowDays: number = EFFECTIVENESS_DEFAULT_WINDOW_DAYS,
): Promise<ActionEffectivenessReport> {
  // The module is the wall, not the parse: the contract bounds 1..365 but
  // zod coerces without .int(), and a fractional day would 22P02 inside
  // make_interval — clamp and floor here so no input shape can 500 this.
  const days = Math.min(365, Math.max(1, Math.floor(windowDays)));
  const db = getDb();
  // Per-kind decision aggregates — the ledger's own decision-time truth.
  const kindRows = (
    await db.execute<{
      kind: string;
      decisions: number;
      auto_decisions: number;
      requested: number;
      executed: number;
      skipped: number;
      failed: number;
    }>(sql`
      SELECT kind,
        COUNT(*)::int AS decisions,
        COUNT(*) FILTER (WHERE policy_id IS NOT NULL)::int AS auto_decisions,
        COALESCE(SUM(requested_count), 0)::int AS requested,
        COALESCE(SUM(executed_count), 0)::int AS executed,
        COALESCE(SUM(skipped_count), 0)::int AS skipped,
        COALESCE(SUM(failed_count), 0)::int AS failed
      FROM clerk_action_decisions
      WHERE firm_id = ${firmId}
        AND client_party_id = ${clientPartyId}
        AND created_at >= now() - make_interval(days => ${days})
      GROUP BY kind
      ORDER BY kind
    `)
  ).rows;

  // Where each EXECUTED submit target stands NOW: unnest the decision's
  // per-target outcomes and re-read the invoice. Only 'submitted' outcomes
  // are re-read (skips never ran; failures already counted); an invoice
  // since purged simply drops out (LEFT JOIN keeps the bucket honest via
  // now_other). Buckets: succeeded = the rails accepted it and any later
  // commercial lifecycle (stamped/confirmed/settled/credited); in flight =
  // still 'submitted'; failed again = the rails rejected it after the
  // batch reported success — the number a reader must never lose.
  // Semantics, deliberately: counting is per EXECUTED OCCURRENCE, not per
  // distinct invoice — a target submitted in two window decisions (failed,
  // retried) contributes its current status twice, so the NOW buckets
  // always sum to `executed` per kind. Do not "fix" this to DISTINCT
  // without deciding what `executed` should then mean.
  // The invoiceId cast is guarded by a CASE (evaluation order inside a
  // plain ON clause is not contractual): a malformed id — only reachable
  // via a hand-written ledger row, every real writer is uuid-validated —
  // degrades to the `other` bucket instead of 22P02-failing the report.
  const nowRows = (
    await db.execute<{
      kind: string;
      now_succeeded: number;
      now_in_flight: number;
      now_failed_again: number;
      now_other: number;
    }>(sql`
      SELECT d.kind,
        COUNT(*) FILTER (
          WHERE i.status IN ('stamped', 'confirmed', 'settled', 'credited')
        )::int AS now_succeeded,
        COUNT(*) FILTER (WHERE i.status = 'submitted')::int AS now_in_flight,
        COUNT(*) FILTER (WHERE i.status = 'failed')::int AS now_failed_again,
        COUNT(*) FILTER (
          WHERE i.status IS NULL
            OR i.status NOT IN
              ('stamped', 'confirmed', 'settled', 'credited', 'submitted', 'failed')
        )::int AS now_other
      FROM clerk_action_decisions d
      CROSS JOIN LATERAL jsonb_array_elements(d.targets) AS t(el)
      LEFT JOIN invoices i ON i.id = CASE
        WHEN t.el ->> 'invoiceId'
          ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (t.el ->> 'invoiceId')::uuid
      END
      WHERE d.firm_id = ${firmId}
        AND d.client_party_id = ${clientPartyId}
        AND d.created_at >= now() - make_interval(days => ${days})
        AND d.kind IN ('submit_overdue', 'retry_failed')
        AND t.el ->> 'outcome' = 'submitted'
      GROUP BY d.kind
    `)
  ).rows;
  const nowByKind = new Map(nowRows.map((r) => [r.kind, r]));

  const kinds: ActionEffectivenessKindRow[] = kindRows.map((r) => {
    const isSubmitKind = (SUBMIT_KINDS as readonly string[]).includes(r.kind);
    const now = nowByKind.get(r.kind);
    return {
      kind: r.kind,
      decisions: Number(r.decisions),
      autoDecisions: Number(r.auto_decisions),
      requested: Number(r.requested),
      executed: Number(r.executed),
      skipped: Number(r.skipped),
      failed: Number(r.failed),
      nowSucceeded: isSubmitKind ? Number(now?.now_succeeded ?? 0) : null,
      nowInFlight: isSubmitKind ? Number(now?.now_in_flight ?? 0) : null,
      nowFailedAgain: isSubmitKind ? Number(now?.now_failed_again ?? 0) : null,
      nowOther: isSubmitKind ? Number(now?.now_other ?? 0) : null,
    };
  });

  // Exposure honesty (round-29 review): a submitted-then-failed-again
  // target did NOT have its exposure removed — the invoice is back in
  // penalty territory, and the card shows that one line above. Count only
  // the executed submit_overdue occurrences still standing on the rails.
  const overdueKind = kinds.find((k) => k.kind === "submit_overdue");
  const standingOverdue = Math.max(
    0,
    (overdueKind?.executed ?? 0) - (overdueKind?.nowFailedAgain ?? 0),
  );

  return {
    windowDays: days,
    totals: {
      decisions: kinds.reduce((n, k) => n + k.decisions, 0),
      autoDecisions: kinds.reduce((n, k) => n + k.autoDecisions, 0),
      executed: kinds.reduce((n, k) => n + k.executed, 0),
      failed: kinds.reduce((n, k) => n + k.failed, 0),
    },
    exposureFloorClearedNgn: bandExposure(standingOverdue).small,
    kinds,
  };
}
