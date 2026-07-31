import { eq, sql } from "drizzle-orm";
import { getDb, firmsTable, partiesTable } from "@workspace/db";
import {
  lagosDateString,
  lagosMidnightFor,
  lagosParts,
} from "../../lib/lagos-time";
import { monthLabel } from "../clerk/client-statement";
import { DomainError } from "../errors";
import { UNSUBMITTED_STATE } from "./compliance-window";
import {
  getReceivablesSummary,
  RECEIVABLE_ORIENTATION,
  type ReceivablesSummary,
} from "./receivables";
import { payablesSummary, type PayablesSummary } from "./payables";
import {
  computeVatPosition,
  vatPositionMonths,
  type VatPosition,
} from "./vat-position";
import {
  countOpenObligations,
  openObligationSamples,
} from "../obligations/obligations";

// Monthly client compliance pack (contract 0.45.0): one client's Lagos month
// as a single facts object — who they are, what they issued, who owes them,
// what they owe, where their VAT stands, and what is due next. Deterministic
// SQL end to end, zero model calls, nothing stored; the ONLY model touch in
// the whole feature is the cover-note phrasing (clerk/pack-note.ts), which
// falls back to a template. Every section reuses the module that already owns
// its numbers (receivables.ts, payables.ts, vat-position.ts), so the pack can
// never disagree with the dashboards it summarizes.

// Register cap: a month's register beyond this many rows renders a truncation
// disclosure instead of an unbounded table (LIMIT+1 probe, rows stay capped).
export const PACK_REGISTER_LIMIT = 200;

export interface PackRegisterRow {
  invoiceNumber: string;
  kind: "invoice" | "credit_note";
  status: string;
  counterparty: string;
  currency: string;
  grandTotal: string;
}

export interface CompliancePackFacts {
  firmId: string;
  firmName: string;
  clientPartyId: string;
  clientName: string;
  monthStart: string;
  monthLabel: string;
  // The requestable months, newest first — vatPositionMonths (live-month
  // list, current month included): the pack is a running month-to-date
  // document exactly like the VAT position it contains.
  months: string[];
  register: { rows: PackRegisterRow[]; truncated: boolean };
  receivables: ReceivablesSummary;
  payables: PayablesSummary;
  vat: VatPosition;
  // Notice Desk: the client's open authority obligations as of render time
  // (countOpenObligations / openObligationSamples — the obligations module
  // owns every predicate; the pack only displays). `rows` is a newest-
  // deadline-first sample capped at the module's display limit.
  obligations: {
    open: number;
    dueSoon: number;
    overdue: number;
    nearestDue: string | null;
    rows: {
      authority: string;
      noticeType: string;
      reference: string | null;
      responseDueDate: string;
    }[];
  };
  deadlines: {
    // The first statutory VAT-return date (the Lagos 21st rule) strictly
    // after today — "what is the next clock this client faces".
    nextVatReturnDue: string;
    // Unsubmitted receivable documents (draft/validated, receivable
    // orientation) — the submission backlog the deadline presses on.
    unsubmittedReceivables: number;
  };
}

// The client's issued documents in the Lagos issue-month: the SAME month
// window as the VAT position's packMonthDocsSql (vat-pack.ts; issue_date in
// [monthStart, +1 month)), deliberately WITHOUT its accepted-attempt or
// cancelled filters — a register lists every document the client put a
// number on (drafts, failures and cancellations included; the status column
// tells that story), while the VAT output side counts rails-accepted paper
// only. Any edit here must keep the month boundary identical to the
// position's or the two sections of one pack disagree about "the month".
async function loadRegister(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
): Promise<CompliancePackFacts["register"]> {
  const rows = (
    await getDb().execute<{
      invoice_number: string;
      kind: "invoice" | "credit_note";
      status: string;
      counterparty: string;
      currency: string;
      grand_total: string;
    }>(sql`
      SELECT
        i.invoice_number,
        i.kind::text AS kind,
        i.status::text AS status,
        p.legal_name AS counterparty,
        i.currency,
        i.grand_total::text AS grand_total
      FROM invoices i
      JOIN parties p ON p.id = i.buyer_party_id
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND i.kind IN ('invoice', 'credit_note')
        AND i.issue_date >= ${monthStart}::date
        AND i.issue_date < (${monthStart}::date + interval '1 month')
      ORDER BY i.issue_date, i.invoice_number
      LIMIT ${sql.raw(String(PACK_REGISTER_LIMIT + 1))}
    `)
  ).rows;
  const truncated = rows.length > PACK_REGISTER_LIMIT;
  return {
    rows: rows.slice(0, PACK_REGISTER_LIMIT).map((r) => ({
      invoiceNumber: r.invoice_number,
      kind: r.kind,
      status: r.status,
      counterparty: r.counterparty,
      currency: r.currency,
      grandTotal: r.grand_total,
    })),
    truncated,
  };
}

// The next statutory VAT-return date: due the 21st of the month following
// each period — the compliance-calendar.ts rule (which the SME deadline card
// shares), reduced to "the first 21st strictly after the Lagos today". Offset
// 0 covers THIS month's 21st while it is still ahead; once it has passed (or
// is today — a date due today is not "next", matching the calendar's
// `dueDate <= today` skip), next month's 21st is always strictly ahead, so
// the two-offset walk is total.
export function nextVatReturnDue(now: Date = new Date()): string {
  const today = lagosDateString(now);
  const { year, monthIndex } = lagosParts(now);
  for (const offset of [0, 1]) {
    const due = lagosDateString(lagosMidnightFor(year, monthIndex + offset, 21));
    if (due > today) return due;
  }
  /* c8 ignore next — unreachable: next month's 21st is always ahead */
  return lagosDateString(lagosMidnightFor(year, monthIndex + 1, 21));
}

// The submission backlog, pinned to ONE client: the compliance-calendar.ts
// predicate (UNSUBMITTED_STATE — compliance-window.ts, the ONE home of the
// draft/validated pair — plus receivable orientation: captured bills are
// draft forever and must not read as an eternal backlog; no `kind` filter,
// because credit notes and corrections carry submission deadlines too).
async function countUnsubmittedReceivables(
  firmId: string,
  clientPartyId: string,
): Promise<number> {
  const rows = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND ${UNSUBMITTED_STATE}
        AND ${RECEIVABLE_ORIENTATION}
    `)
  ).rows;
  return Number(rows[0]?.n ?? 0);
}

export async function computeCompliancePack(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
): Promise<CompliancePackFacts> {
  // Names first: an unknown party (or firm) is a 404, not a pack of zeroes —
  // the route's scope gates have already run, so this only trips on a truly
  // absent row.
  const [[firm], [client]] = await Promise.all([
    getDb()
      .select({ name: firmsTable.name })
      .from(firmsTable)
      .where(eq(firmsTable.id, firmId))
      .limit(1),
    getDb()
      .select({ legalName: partiesTable.legalName })
      .from(partiesTable)
      .where(eq(partiesTable.id, clientPartyId))
      .limit(1),
  ]);
  if (!firm || !client) {
    throw new DomainError("NOT_FOUND", "Client not found", 404);
  }

  const [
    register,
    receivables,
    payables,
    vat,
    unsubmittedReceivables,
    obligationCounts,
    obligationRows,
  ] = await Promise.all([
    loadRegister(firmId, clientPartyId, monthStart),
    getReceivablesSummary(clientPartyId, firmId),
    payablesSummary(firmId, clientPartyId),
    computeVatPosition(firmId, clientPartyId, monthStart),
    countUnsubmittedReceivables(firmId, clientPartyId),
    countOpenObligations(firmId, clientPartyId),
    openObligationSamples(firmId, clientPartyId),
  ]);

  return {
    firmId,
    firmName: firm.name,
    clientPartyId,
    clientName: client.legalName,
    monthStart,
    monthLabel: monthLabel(monthStart),
    months: vatPositionMonths(),
    register,
    receivables,
    payables,
    vat,
    obligations: {
      open: obligationCounts.open,
      dueSoon: obligationCounts.dueSoon,
      overdue: obligationCounts.overdue,
      nearestDue: obligationCounts.nearestDue,
      rows: obligationRows.map((r) => ({
        authority: r.authority,
        noticeType: r.noticeType,
        reference: r.reference,
        responseDueDate: r.responseDueDate,
      })),
    },
    deadlines: {
      nextVatReturnDue: nextVatReturnDue(),
      unsubmittedReceivables,
    },
  };
}
