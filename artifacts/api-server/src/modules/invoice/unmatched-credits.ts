import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";

// Unmatched-credit detector (round-14 idea #1). Unbilled-income asks "where
// is the invoice that usually goes OUT?"; this asks the compliance mirror —
// "where is the invoice behind the money that came IN?" A bank credit that
// matches no invoice is potentially an off-platform sale, which is exactly
// what a VAT audit finds first. Pure SQL over the client's own committed
// statement lines, computed on demand, nothing stored, zero model calls.
//
// Definitions, pinned:
//  - a candidate is a PARSED credit line with a value date inside the
//    trailing window;
//  - "unmatched" means the reconciliation exhaust offers NO explanation:
//    no live match proposal (proposed or accepted — a pending proposal
//    means the matcher found a candidate invoice, i.e. the reconciliation
//    screen already owns that line) and no settlement event referencing
//    the line (belt and braces: buyer-flag settlements never reference
//    lines, accepted matches always do);
//  - this is an ADVISORY, never an accusation of wrongdoing: a transfer
//    between own accounts, a loan or a refund also looks like this — the
//    note says so, and the client disposes.
// Tenancy is the caller's (route layer): firm + SEC-03 client party, the
// same resolution as the other history miners.

const WINDOW_DAYS = 90;
const MAX_ROWS = 20;

export interface UnmatchedCreditRow {
  lineId: string;
  statementId: string;
  valueDate: string;
  amount: string;
  narration: string | null;
  counterpartyRef: string | null;
}

export interface UnmatchedCredits {
  asOf: string;
  windowDays: number;
  // Uncapped window totals (same query pass discipline as the report cards —
  // the capped row list can never deflate them).
  count: number;
  totalAmount: string;
  rows: UnmatchedCreditRow[];
  truncated: boolean;
  note: string;
}

// The unmatched-candidate predicate over `l` (bank_statement_lines) joined
// to `s` (bank_statements) — one fragment shared by the client card, its
// aggregate and the firm-wide digest count, so no two surfaces can disagree.
function unmatchedCondition(
  firmId: string,
  since: string,
  clientPartyId?: string,
) {
  return sql`s.firm_id = ${firmId}
    ${clientPartyId ? sql`AND s.client_party_id = ${clientPartyId}` : sql``}
    AND s.status = 'committed'
    AND l.parse_status = 'parsed'
    AND l.direction = 'credit'
    AND l.amount IS NOT NULL
    AND l.value_date IS NOT NULL
    AND l.value_date >= ${since}
    AND NOT EXISTS (
      SELECT 1 FROM match_proposals m
      WHERE m.statement_line_id = l.id AND m.status IN ('proposed', 'accepted')
    )
    AND NOT EXISTS (
      SELECT 1 FROM settlement_events se WHERE se.statement_line_id = l.id
    )`;
}

export async function listUnmatchedCredits(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<UnmatchedCredits> {
  const since = lagosDateString(
    new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
  );
  const db = getDb();
  const cond = unmatchedCondition(firmId, since, clientPartyId);

  const [agg] = (
    await db.execute<{ n: number; total: string }>(sql`
      SELECT COUNT(*)::int AS n,
        COALESCE(SUM(l.amount), 0)::numeric(18,2)::text AS total
      FROM bank_statement_lines l
      JOIN bank_statements s ON s.id = l.statement_id
      WHERE ${cond}
    `)
  ).rows;

  const rows = (
    await db.execute<{
      id: string;
      statement_id: string;
      value_date: string;
      amount: string;
      narration: string | null;
      counterparty_ref: string | null;
    }>(sql`
      SELECT l.id, l.statement_id, l.value_date::text AS value_date,
        l.amount::text AS amount, l.narration, l.counterparty_ref
      FROM bank_statement_lines l
      JOIN bank_statements s ON s.id = l.statement_id
      WHERE ${cond}
      ORDER BY l.amount DESC, l.value_date DESC, l.id
      LIMIT ${MAX_ROWS + 1}
    `)
  ).rows;

  return {
    asOf: lagosDateString(now),
    windowDays: WINDOW_DAYS,
    count: Number(agg?.n ?? 0),
    totalAmount: String(agg?.total ?? "0.00"),
    rows: rows.slice(0, MAX_ROWS).map((r) => ({
      lineId: r.id,
      statementId: r.statement_id,
      valueDate: r.value_date,
      amount: String(r.amount),
      narration: r.narration,
      counterpartyRef: r.counterparty_ref,
    })),
    truncated: rows.length > MAX_ROWS,
    note:
      `Credits on your bank statements from the last ${WINDOW_DAYS} days that match no invoice on the platform. ` +
      `Money can arrive without an invoice for many legitimate reasons — a transfer between your own accounts, a loan, a refund. ` +
      `But if any of these is a sale, an e-invoice should exist for it: raise one, or upload the missing invoice so it can be matched.`,
  };
}

// Firm-wide count for the weekly digest — same predicate, aggregated across
// every client with committed statements (the digest runs in the sweep's
// bypass context, so no per-client resolution here).
export async function countFirmUnmatchedCredits(
  firmId: string,
  now: Date = new Date(),
): Promise<{ credits: number; clients: number }> {
  const since = lagosDateString(
    new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
  );
  const [row] = (
    await getDb().execute<{ credits: number; clients: number }>(sql`
      SELECT COUNT(*)::int AS credits,
        COUNT(DISTINCT s.client_party_id)::int AS clients
      FROM bank_statement_lines l
      JOIN bank_statements s ON s.id = l.statement_id
      WHERE ${unmatchedCondition(firmId, since)}
    `)
  ).rows;
  return {
    credits: Number(row?.credits ?? 0),
    clients: Number(row?.clients ?? 0),
  };
}
