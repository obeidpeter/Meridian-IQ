import { sql, type SQL } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { rate, type ClerkMetrics } from "./metrics-core";

// Clerk metrics — the clerk_cases query group (R126, split from metrics.ts):
// case throughput and turnaround, per-field override rates, per-supplier
// accuracy and Ask outcomes. Each loader takes the façade's `since` SQL
// fragment unchanged and awaits its own queries in the original order.
// clerk_cases is bypass-only RLS; these read under the operator/bypass
// context exactly as before.

export async function loadCaseMetrics(
  since: SQL,
): Promise<ClerkMetrics["cases"]> {
  const db = getDb();
  const caseRows = (
    await db.execute(sql`
      SELECT kind, status, COUNT(*)::int AS count
      FROM clerk_cases
      WHERE created_at >= ${since}
      GROUP BY kind, status
    `)
  ).rows as { kind: string; status: string; count: number }[];

  const byStatus: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  let total = 0;
  for (const r of caseRows) {
    total += r.count;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + r.count;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.count;
  }

  // Median human turnaround for decided extraction cases: creation (intake +
  // machine extraction) to the recorded decision. updated_at is the decision
  // write because decided cases take no further writes.
  const decisionRows = (
    await db.execute(sql`
      SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60.0) AS avg_minutes
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'extraction'
        AND decided_by IS NOT NULL
    `)
  ).rows as { avg_minutes: string | null }[];
  const avgDecisionMinutes =
    decisionRows[0]?.avg_minutes != null
      ? Number(Number(decisionRows[0].avg_minutes).toFixed(1))
      : null;

  // Claim timestamps split turnaround into queue-wait (created -> claimed) and
  // active review (claimed -> decision) — the CLK-OPS-06 operator-time signal.
  const timingRows = (
    await db.execute(sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (claimed_at - created_at)) / 60.0)
          AS queue_minutes,
        AVG(EXTRACT(EPOCH FROM (updated_at - claimed_at)) / 60.0)
          FILTER (WHERE decided_by IS NOT NULL) AS active_minutes
      FROM clerk_cases
      WHERE created_at >= ${since}
        AND kind = 'extraction'
        AND claimed_at IS NOT NULL
    `)
  ).rows as { queue_minutes: string | null; active_minutes: string | null }[];
  const avgQueueWaitMinutes =
    timingRows[0]?.queue_minutes != null
      ? Number(Number(timingRows[0].queue_minutes).toFixed(1))
      : null;
  const avgActiveReviewMinutes =
    timingRows[0]?.active_minutes != null
      ? Number(Number(timingRows[0].active_minutes).toFixed(1))
      : null;

  return {
    total,
    byStatus,
    byKind,
    avgDecisionMinutes,
    avgQueueWaitMinutes,
    avgActiveReviewMinutes,
  };
}

// Per-field override rates from the correction exhaust: how often the
// operator changed each field the model proposed (approved cases only).
export async function loadCorrectionRates(
  since: SQL,
): Promise<ClerkMetrics["corrections"]> {
  const correctionRows = (
    await getDb().execute(sql`
      SELECT
        c ->> 'field' AS field,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (c ->> 'changed')::boolean)::int AS overridden
      FROM clerk_cases, LATERAL jsonb_array_elements(corrections) AS c
      WHERE created_at >= ${since} AND corrections IS NOT NULL
      GROUP BY 1
      ORDER BY 3 DESC, 1
    `)
  ).rows as { field: string; total: number; overridden: number }[];
  return correctionRows.map((c) => ({
    field: c.field,
    total: c.total,
    overridden: c.overridden,
    overrideRate: rate(c.overridden, c.total),
  }));
}

// Per-supplier accuracy: one row per supplier party whose approved cases
// carry a corrections diff in the window, worst offenders (most overridden
// fields) first. The supplier is the APPROVED invoice's register party —
// the same join eval-growth stamps onto fixtures — so the numbers name real
// register identities, never extracted strings.
export async function loadSupplierAccuracy(
  since: SQL,
): Promise<ClerkMetrics["supplierAccuracy"]> {
  const supplierRows = (
    await getDb().execute(sql`
      SELECT
        p.legal_name AS supplier_name,
        f.name AS firm_name,
        COUNT(DISTINCT c.id)::int AS cases,
        COUNT(*)::int AS fields_compared,
        COUNT(*) FILTER (WHERE (cor ->> 'changed')::boolean)::int AS overridden
      FROM clerk_cases c
      JOIN invoices i ON i.id = c.created_invoice_id
      JOIN parties p ON p.id = i.supplier_party_id
      LEFT JOIN firms f ON f.id = c.firm_id
      CROSS JOIN LATERAL jsonb_array_elements(c.corrections) AS cor
      WHERE c.created_at >= ${since}
        AND c.kind = 'extraction'
        AND c.corrections IS NOT NULL
      GROUP BY p.id, p.legal_name, f.name
      ORDER BY 5 DESC, 4 DESC
      LIMIT 20
    `)
  ).rows as {
    supplier_name: string;
    firm_name: string | null;
    cases: number;
    fields_compared: number;
    overridden: number;
  }[];
  return supplierRows.map((s) => ({
    supplierName: s.supplier_name,
    firmName: s.firm_name,
    cases: s.cases,
    fieldsCompared: s.fields_compared,
    overridden: s.overridden,
    overrideRate: rate(s.overridden, s.fields_compared),
  }));
}

// Ask outcomes come from the answer payload: answered=true means a claim
// rendered; everything else was a refusal-and-escalate.
export async function loadAskOutcomes(
  since: SQL,
): Promise<ClerkMetrics["ask"]> {
  const askRows = (
    await getDb().execute(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE (answer ->> 'answered') = 'true')::int AS answered
      FROM clerk_cases
      WHERE created_at >= ${since} AND kind = 'question'
    `)
  ).rows as { total: number; answered: number }[];
  const askTotal = askRows[0]?.total ?? 0;
  const answered = askRows[0]?.answered ?? 0;
  return {
    total: askTotal,
    answered,
    refused: askTotal - answered,
    refusalRate: rate(askTotal - answered, askTotal),
  };
}
