import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import {
  lagosDateString,
  lagosMidnightFor,
  lagosParts,
} from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS } from "./compliance-window";

// Firm-level compliance calendar (round-6 idea #5). The SME dashboard already
// computes per-client deadlines (routes/sme.ts computeDeadlines); this is the
// FIRM's month-ahead view of the same statutory clocks, aggregated across
// every client in one SQL pass — zero model calls, nothing stored. The
// predicates deliberately reuse the same constants and Lagos-calendar
// expressions as the dashboard and the reminder sweep
// (SUBMISSION_WINDOW_DAYS, the (issue_date + N) deadline date, VAT due the
// 21st of the following month), so this view can never disagree with what
// each client sees.

export const CALENDAR_HORIZON_DAYS = 35;

export interface CalendarEvent {
  kind: "invoice_submission" | "vat_return";
  label: string;
  // Present for invoice_submission events.
  invoices?: number;
  clients?: number;
}

export interface CalendarDay {
  date: string; // Lagos calendar date ("YYYY-MM-DD")
  events: CalendarEvent[];
}

export interface ComplianceCalendar {
  horizonDays: number;
  // Unsubmitted invoices already past their submission deadline — the
  // backlog that precedes the calendar rather than sitting on a future day.
  overdue: { invoices: number; clients: number };
  days: CalendarDay[];
}

export async function computeComplianceCalendar(
  firmId: string,
  now: Date = new Date(),
): Promise<ComplianceCalendar> {
  const today = lagosDateString(now);
  // The submit-by DATE is issue_date + WINDOW: the statutory instant is Lagos
  // midnight at the START of that date (compliance-window.ts), so an invoice
  // whose due date is today or earlier is already overdue.
  const rows = (
    await getDb().execute<{
      due: string;
      invoices: number;
      clients: number;
    }>(sql`
      SELECT
        (issue_date + make_interval(days => ${SUBMISSION_WINDOW_DAYS}))::date::text AS due,
        COUNT(*)::int AS invoices,
        COUNT(DISTINCT supplier_party_id)::int AS clients
      FROM invoices
      WHERE firm_id = ${firmId}
        AND kind = 'invoice'
        AND status IN ('draft', 'validated')
      GROUP BY 1
      ORDER BY 1
    `)
  ).rows;

  let overdueInvoices = 0;
  const byDate = new Map<string, CalendarEvent[]>();
  const horizonEnd = lagosDateString(
    new Date(now.getTime() + CALENDAR_HORIZON_DAYS * 24 * 60 * 60 * 1000),
  );
  for (const r of rows) {
    if (r.due <= today) {
      overdueInvoices += Number(r.invoices);
      // Distinct clients per day can overlap across days; the overdue client
      // count is approximated by the max per-day distinct count unless we
      // re-query — one more cheap aggregate keeps it exact instead.
      continue;
    }
    if (r.due > horizonEnd) continue;
    const list = byDate.get(r.due) ?? [];
    list.push({
      kind: "invoice_submission",
      label: `Submission window closes for ${r.invoices} invoice(s) across ${r.clients} client(s)`,
      invoices: Number(r.invoices),
      clients: Number(r.clients),
    });
    byDate.set(r.due, list);
  }

  // Exact distinct-client count for the overdue backlog (a client can appear
  // on several overdue days; summing per-day distincts would overcount).
  const [overdueRow] = (
    await getDb().execute<{ clients: number }>(sql`
      SELECT COUNT(DISTINCT supplier_party_id)::int AS clients
      FROM invoices
      WHERE firm_id = ${firmId}
        AND kind = 'invoice'
        AND status IN ('draft', 'validated')
        AND (issue_date + make_interval(days => ${SUBMISSION_WINDOW_DAYS}))::date::text <= ${today}
    `)
  ).rows;

  // Statutory VAT filing dates inside the horizon: due the 21st of the month
  // following each period (same rule as the SME dashboard's deadline card).
  // Offset 0 covers THIS month's 21st while it is still ahead (the return
  // for last month's period) — a true statutory date the calendar must not
  // skip; past dates filter out below.
  const { year, monthIndex } = lagosParts(now);
  for (const offset of [0, 1, 2]) {
    const due = lagosMidnightFor(year, monthIndex + offset, 21);
    const dueDate = lagosDateString(due);
    if (dueDate <= today || dueDate > horizonEnd) continue;
    const list = byDate.get(dueDate) ?? [];
    list.push({
      kind: "vat_return",
      label: "Monthly VAT return and remittance due (FIRS)",
    });
    byDate.set(dueDate, list);
  }

  const days: CalendarDay[] = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, events]) => ({
      date,
      // Statutory dates first on a shared day, then the invoice batch.
      events: [...events].sort((a, b) => a.kind.localeCompare(b.kind) * -1),
    }));

  return {
    horizonDays: CALENDAR_HORIZON_DAYS,
    overdue: {
      invoices: overdueInvoices,
      clients: Number(overdueRow?.clients ?? 0),
    },
    days,
  };
}
