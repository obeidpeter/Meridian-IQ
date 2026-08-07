import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import {
  getReceivablesSummary,
  type ReceivablesSummary,
} from "../invoice/receivables";
import { payablesSummary, type PayablesSummary } from "../invoice/payables";
import {
  computeVatPosition,
  vatPositionMonths,
  type VatPosition,
} from "../invoice/vat-position";
import { countOpenFilings } from "../filings/filings";
import { countWhtChase } from "../wht/credits";
import { countOpenObligations } from "../obligations/obligations";
import {
  computeAutomationEvidence,
  type AutomationEvidence,
} from "../clerk/automation-evidence";

// The client's issued-paper span — the history_imported detection
// (onboarding.ts) AND the opening position's history line share this one
// query. Lives HERE so the import edge onboarding → opening-position stays
// one-way (no cycle).
export async function invoiceHistorySpan(
  firmId: string,
  clientPartyId: string,
): Promise<{
  invoiceCount: number;
  earliestIssueDate: string | null;
  latestIssueDate: string | null;
}> {
  const [row] = (
    await getDb().execute<{
      n: number;
      earliest: string | null;
      latest: string | null;
    }>(sql`
      SELECT COUNT(*)::int AS n,
             MIN(i.issue_date)::text AS earliest,
             MAX(i.issue_date)::text AS latest
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
    `)
  ).rows;
  return {
    invoiceCount: Number(row?.n ?? 0),
    earliestIssueDate: row?.earliest ?? null,
    latestIssueDate: row?.latest ?? null,
  };
}

// Onboard with Clerk Phase 2: the DAY-ONE OPENING POSITION — where a client
// stands the moment the firm takes them on. Every section reuses the module
// that already owns its numbers (the compliance pack's composition rule:
// this baseline can never disagree with the dashboards it summarizes), and
// the automation section is the per-client evidence backtest replayed over
// the imported history — the firm's day-one answer to "what could Clerk
// already do for this client, judged on their own record". Deterministic
// SQL end to end, zero model calls.
//
// Two lives: PROVISIONAL while the run is active (recomputed on request —
// the numbers move as history lands), then FROZEN onto the run row by the
// completion CAS (onboarding.ts) — the permanent "where we started"
// baseline the readiness report (Phase 3) reads.

export interface OpeningPosition {
  computedAt: string;
  // True while the run is still active: history is still landing, so the
  // numbers are a moving picture, not the baseline.
  provisional: boolean;
  history: {
    invoiceCount: number;
    earliestIssueDate: string | null;
    latestIssueDate: string | null;
  };
  receivables: ReceivablesSummary;
  payables: PayablesSummary;
  // The current Lagos month-to-date position (vatPositionMonths()[0]).
  vat: VatPosition;
  filings: {
    unfiled: number;
    dueSoon: number;
    overdue: number;
    nextDueDate: string | null;
  };
  wht: { awaiting: number; awaitingAmount: string };
  obligations: {
    open: number;
    dueSoon: number;
    overdue: number;
    nearestDue: string | null;
  };
  automation: AutomationEvidence;
}

export async function computeOpeningPosition(
  firmId: string,
  clientPartyId: string,
  opts: { provisional: boolean; now?: Date } = { provisional: true },
): Promise<OpeningPosition> {
  const now = opts.now ?? new Date();
  // Sequential on one connection (the onboarding module's detectAll note:
  // parallel awaits only queue on the client, and pg deprecates overlap).
  const history = await invoiceHistorySpan(firmId, clientPartyId);
  // `now` threads into every section that stamps a date (asOf, the months
  // list, the note) so a frozen baseline carries ONE consistent instant
  // even when completion straddles a Lagos midnight.
  const receivables = await getReceivablesSummary(clientPartyId, firmId, now);
  const payables = await payablesSummary(firmId, clientPartyId);
  const vat = await computeVatPosition(
    firmId,
    clientPartyId,
    vatPositionMonths(1, now)[0],
    now,
  );
  const filings = await countOpenFilings(firmId, clientPartyId);
  const wht = await countWhtChase(firmId, clientPartyId);
  const obligations = await countOpenObligations(firmId, clientPartyId);
  const automation = await computeAutomationEvidence(
    firmId,
    now,
    clientPartyId,
  );
  return {
    computedAt: now.toISOString(),
    provisional: opts.provisional,
    history,
    receivables,
    payables,
    vat,
    filings: {
      unfiled: filings.unfiled,
      dueSoon: filings.dueSoon,
      overdue: filings.overdue,
      nextDueDate: filings.nextDueDate,
    },
    wht,
    obligations: {
      open: obligations.open,
      dueSoon: obligations.dueSoon,
      overdue: obligations.overdue,
      nearestDue: obligations.nearestDue,
    },
    automation,
  };
}
