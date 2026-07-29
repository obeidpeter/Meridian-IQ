import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { logger } from "../../lib/logger";
import { lagosDateString } from "../../lib/lagos-time";
import { addDays, daysBetween } from "./date-math";
import {
  detectMonthlyPattern,
  LOOKBACK_DAYS,
  type HistoryRow,
} from "./recurring-suggest";
import { BILL_OF_CLIENT } from "./payables";
import { BILL_ORIENTATION } from "./receivables";

// Missing recurring bills (round-18 idea #3) — the payables mirror of
// unbilled-income detection: the same deterministic monthly-pattern miner
// that spots "this client bills that buyer every month" spots the vendor
// whose bill arrives every month and has NOT been captured this cycle. A
// missing capture means input VAT silently lost from the VAT position and a
// payment about to surprise the cash outlook. Computed on demand — zero
// model calls, nothing stored — under the SAME pattern thresholds
// (detectMonthlyPattern) and the SAME alert window discipline as
// unbilled-income.ts:
//  - GRACE_DAYS of slack before the card speaks (vendor cadences wobble);
//  - silence past MAX_OVERDUE_DAYS means the arrangement probably ENDED —
//    a cancelled subscription is not a missing bill.

const GRACE_DAYS = 5;
const MAX_OVERDUE_DAYS = 45;
const MAX_ALERTS = 5;

// Scan caps, fetched cap+1 so truncation is DETECTED, never silent (the
// ask.ts rule): a truncated ASC scan would drop the NEWEST bills, making a
// captured vendor look uncaptured — a manufactured alert. Past the cap the
// advisory fails QUIET (no alerts): a card that cannot see the whole year
// must not speak.
const CLIENT_SCAN_CAP = 50_000;
const FIRM_SCAN_CAP = 100_000;

export interface MissingBillAlert {
  supplierPartyId: string;
  supplierName: string;
  count: number;
  medianAmount: string;
  medianGapDays: number;
  lastIssueDate: string;
  expectedByDate: string;
  overdueDays: number;
}

// Pure projection over one vendor's mined bill pattern, exported for tests —
// the unbilledAlertFor rule pointed at the capture side.
export function missingBillAlertFor(
  bills: HistoryRow[],
  todayLagos: string,
): Omit<MissingBillAlert, "supplierPartyId" | "supplierName"> | null {
  const pattern = detectMonthlyPattern(bills);
  if (!pattern) return null;
  const expectedByDate = addDays(pattern.lastIssueDate, pattern.medianGapDays);
  const overdueDays = daysBetween(expectedByDate, todayLagos);
  if (overdueDays < GRACE_DAYS || overdueDays > MAX_OVERDUE_DAYS) return null;
  return {
    count: pattern.count,
    medianAmount: String(pattern.medianAmount),
    medianGapDays: pattern.medianGapDays,
    lastIssueDate: pattern.lastIssueDate,
    expectedByDate,
    overdueDays,
  };
}

// One client's captured-bill history per vendor over the trailing year,
// through the canonical bill fragment (BILL_OF_CLIENT — a receivable can
// never pollute a vendor's cadence). Cancelled/credited paper and null
// totals are excluded and merged-away vendors dropped — the exact evidence
// discipline of the miner this mirrors (recurring-suggest.ts: cancelled
// paper is not evidence of a standing arrangement).
async function vendorBillHistories(
  firmId: string,
  clientPartyId: string,
): Promise<Map<string, { name: string; bills: HistoryRow[] }>> {
  const rows = (
    await getDb().execute<{
      supplier_party_id: string;
      supplier_name: string;
      id: string;
      issue_date: string;
      grand_total: string;
    }>(sql`
      SELECT i.supplier_party_id, p.legal_name AS supplier_name,
        i.id, i.issue_date::text AS issue_date, i.grand_total::text AS grand_total
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE ${BILL_OF_CLIENT(firmId, clientPartyId)}
        AND i.status NOT IN ('cancelled', 'credited')
        AND i.grand_total IS NOT NULL
        AND p.merged_into_id IS NULL
        AND i.issue_date >= (now() AT TIME ZONE 'Africa/Lagos')::date - ${LOOKBACK_DAYS}::int
      ORDER BY i.issue_date ASC, i.id
      LIMIT ${CLIENT_SCAN_CAP + 1}
    `)
  ).rows;
  if (rows.length > CLIENT_SCAN_CAP) {
    // Fail quiet for the user, loud for the operator: a firm permanently
    // past the cap loses this advisory, and only this line says why.
    logger.warn(
      { firmId, clientPartyId, cap: CLIENT_SCAN_CAP },
      "missing-bills scan over cap — advisory suppressed",
    );
    return new Map();
  }
  const byVendor = new Map<string, { name: string; bills: HistoryRow[] }>();
  for (const r of rows) {
    const entry = byVendor.get(r.supplier_party_id) ?? {
      name: r.supplier_name,
      bills: [],
    };
    entry.bills.push({
      id: r.id,
      issueDate: r.issue_date,
      grandTotal: Number(r.grand_total),
    });
    byVendor.set(r.supplier_party_id, entry);
  }
  return byVendor;
}

// One client's expected-but-uncaptured vendor bills, biggest money first.
// The route layer owns tenancy + SEC-03 scoping (resolveClientAnalyticsScope,
// the bills-surface idiom).
export async function listMissingRecurringBills(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<MissingBillAlert[]> {
  const byVendor = await vendorBillHistories(firmId, clientPartyId);
  const today = lagosDateString(now);
  const alerts: MissingBillAlert[] = [];
  for (const [supplierPartyId, entry] of byVendor) {
    const alert = missingBillAlertFor(entry.bills, today);
    if (alert) {
      alerts.push({ supplierPartyId, supplierName: entry.name, ...alert });
    }
  }
  alerts.sort((a, b) => Number(b.medianAmount) - Number(a.medianAmount));
  return alerts.slice(0, MAX_ALERTS);
}

// Firm-wide count for the weekly digest — the countFirmUnbilled posture:
// the TRUE count across engaged clients (a fact line, not a nudge list),
// computed from one bills query grouped in memory. Restricted to clients
// with a LIVE engagement (BILL_ORIENTATION only requires an engagement to
// exist): the digest must not nag about a client the firm archived.
export async function countFirmMissingBills(
  firmId: string,
  now: Date = new Date(),
): Promise<{ alerts: number; clients: number }> {
  const rows = (
    await getDb().execute<{
      buyer_party_id: string;
      supplier_party_id: string;
      id: string;
      issue_date: string;
      grand_total: string;
    }>(sql`
      SELECT i.buyer_party_id, i.supplier_party_id,
        i.id, i.issue_date::text AS issue_date, i.grand_total::text AS grand_total
      FROM invoices i
      JOIN parties p ON p.id = i.supplier_party_id
      WHERE i.firm_id = ${firmId}
        AND i.kind = 'invoice'
        AND ${BILL_ORIENTATION}
        AND i.status NOT IN ('cancelled', 'credited')
        AND i.grand_total IS NOT NULL
        AND p.merged_into_id IS NULL
        AND EXISTS (
          SELECT 1 FROM engagements e
          WHERE e.firm_id = i.firm_id
            AND e.client_party_id = i.buyer_party_id
            AND e.status IN ('open', 'in_progress')
        )
        AND i.issue_date >= (now() AT TIME ZONE 'Africa/Lagos')::date - ${LOOKBACK_DAYS}::int
      ORDER BY i.issue_date ASC, i.id
      LIMIT ${FIRM_SCAN_CAP + 1}
    `)
  ).rows;
  if (rows.length > FIRM_SCAN_CAP) {
    logger.warn(
      { firmId, cap: FIRM_SCAN_CAP },
      "missing-bills firm scan over cap — digest fact suppressed",
    );
    return { alerts: 0, clients: 0 };
  }
  const today = lagosDateString(now);
  const byPair = new Map<string, { client: string; bills: HistoryRow[] }>();
  for (const r of rows) {
    const key = `${r.buyer_party_id}:${r.supplier_party_id}`;
    const entry = byPair.get(key) ?? { client: r.buyer_party_id, bills: [] };
    entry.bills.push({
      id: r.id,
      issueDate: r.issue_date,
      grandTotal: Number(r.grand_total),
    });
    byPair.set(key, entry);
  }
  let alerts = 0;
  const clients = new Set<string>();
  for (const entry of byPair.values()) {
    if (missingBillAlertFor(entry.bills, today)) {
      alerts += 1;
      clients.add(entry.client);
    }
  }
  return { alerts, clients: clients.size };
}
