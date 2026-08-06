// Filing Desk Phase 3: the 21st-of-the-month cockpit — every actively-served
// client's current-period return statuses in ONE read. Pure display
// composition: the period and both due dates come from the statutory
// calendar (statutory-calendar.ts, the one home of the 21st/10th rules), the
// statuses from the register rows the mint sweep created, and the overdue
// predicate is the register's own `due_date < today` boundary — this module
// derives, it never decides.
import { and, eq, sql } from "drizzle-orm";
import { getDb, filingReturnsTable, type FilingReturn } from "@workspace/db";
// Reused server-side month naming (lib/format's filingPeriodLabel is a
// FRONTEND package the api-server deliberately does not depend on): the
// clerk statement's monthLabel over the period's first day — "2026-07" reads
// "July 2026", the same label every server-rendered paper uses.
import { monthLabel } from "../clerk/client-statement";
// The e-aliased raw fragment the computeFirmVatPositions enumeration below
// is copied from (receivables.ts — the firm rollups' one spelling); the
// filings module's own drizzle-flavored LIVE_ENGAGEMENT cannot compose into
// an aliased raw join.
import { LIVE_ENGAGEMENT } from "../invoice/receivables";
import { lagosDateString } from "../../lib/lagos-time";
import { filingDueDate, previousLagosPeriod } from "./statutory-calendar";

export type FilingMatrixStatus = FilingReturn["status"] | null;

export interface FilingMatrixRow {
  clientPartyId: string;
  clientName: string;
  // Status per kind; null = no row minted for this client/period yet (a
  // client onboarded after the mint — the sync button's case; for wht ALSO
  // the common "no withholding bills this period" case, since the mint only
  // creates wht rows for clients with WHT-categorised bills).
  vat: FilingMatrixStatus;
  paye: FilingMatrixStatus;
  wht: FilingMatrixStatus;
}

export interface FilingMatrix {
  period: string;
  periodLabel: string;
  dueDates: { vat: string; paye: string; wht: string };
  rows: FilingMatrixRow[];
  totals: {
    clients: number;
    // Filed/unfiled count FILINGS (rows × kinds) over MINTED register rows —
    // a null cell is "not minted yet", not "unfiled" (countOpenFilings must
    // stay the one authority on unfiled totals); overdue counts unfiled
    // filings past their statutory date (Lagos today).
    filed: number;
    unfiled: number;
    overdue: number;
  };
}

export async function computeFilingMatrix(
  firmId: string,
  now = new Date(),
): Promise<FilingMatrix> {
  const period = previousLagosPeriod(now);
  const today = lagosDateString(now);

  // One row per client the firm ACTIVELY serves — the computeFirmVatPositions
  // enumeration (live engagements only, selectDistinct because a client can
  // hold several engagements, name-ordered for a stable cockpit).
  const clients = (
    await getDb().execute<{ id: string; legal_name: string }>(sql`
      SELECT DISTINCT e.client_party_id AS id, p.legal_name
      FROM engagements e
      JOIN parties p ON p.id = e.client_party_id
      WHERE e.firm_id = ${firmId} AND ${LIVE_ENGAGEMENT}
      ORDER BY p.legal_name, e.client_party_id
    `)
  ).rows;

  // One set-based read over the register for (firm, period) — never a query
  // per client.
  const filings = await getDb()
    .select({
      clientPartyId: filingReturnsTable.clientPartyId,
      taxType: filingReturnsTable.taxType,
      status: filingReturnsTable.status,
      dueDate: filingReturnsTable.dueDate,
    })
    .from(filingReturnsTable)
    .where(
      and(
        eq(filingReturnsTable.firmId, firmId),
        eq(filingReturnsTable.period, period),
      ),
    );
  const byCell = new Map<string, { status: FilingReturn["status"]; dueDate: string }>();
  for (const f of filings) {
    byCell.set(`${f.clientPartyId}:${f.taxType}`, {
      status: f.status,
      dueDate: f.dueDate,
    });
  }

  let filed = 0;
  let unfiled = 0;
  let overdue = 0;
  const rows: FilingMatrixRow[] = clients.map((c) => {
    const statusFor = (taxType: "vat" | "paye" | "wht"): FilingMatrixStatus => {
      const cell = byCell.get(`${c.id}:${taxType}`);
      if (!cell) return null;
      if (cell.status === "filed") {
        filed += 1;
      } else {
        unfiled += 1;
        // The register's own boundary (filingOverdue: `due_date < today`) —
        // on the due day itself the return can still be filed. Compared on
        // the row's OWN stored due date, so the totals agree with the
        // register even if a calendar rule ever moves between mints.
        if (cell.dueDate < today) overdue += 1;
      }
      return cell.status;
    };
    return {
      clientPartyId: c.id,
      clientName: c.legal_name,
      vat: statusFor("vat"),
      paye: statusFor("paye"),
      // Null for most clients (the mint only creates wht rows for clients
      // with withholding bills in the period); a minted cell counts in the
      // totals exactly like the unconditional kinds.
      wht: statusFor("wht"),
    };
  });

  return {
    period,
    periodLabel: monthLabel(`${period}-01`),
    dueDates: {
      vat: filingDueDate(period, "vat"),
      paye: filingDueDate(period, "paye"),
      wht: filingDueDate(period, "wht"),
    },
    rows,
    totals: { clients: rows.length, filed, unfiled, overdue },
  };
}
