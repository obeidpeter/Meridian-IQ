import { sql, type SQL } from "drizzle-orm";
import { getDb, type ClerkAnswerLink, type ProtectedFact } from "@workspace/db";
import {
  lagosDateString,
  lagosParts,
  lagosTodaySql,
  lagosWindowSql,
} from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
import {
  firmMoneySummary,
  isChaseEligible,
  listChaseRows,
  receivableProjections,
} from "../invoice/cashflow";
import {
  BILL_ORIENTATION,
  OUTSTANDING,
  RECEIVABLE_ORIENTATION,
} from "../invoice/receivables";
import { BILL_UNPAID } from "../invoice/payables";
import { firmClerkUsage } from "./budget";
import { isAre, MONTH_NAMES, plural } from "./text";

// Grounded firm-data Q&A (Clerk idea #6). Ask Clerk gains a SECOND closed
// catalogue next to the claims register: data intents — live lookups over the
// asker's own firm records ("what's overdue?", "what did we submit this
// month?"). The model's only job is still classification: it picks a key from
// the closed enum; the app runs the corresponding query and assembles the
// answer deterministically, so every number a user sees is platform-computed.
//
// The safety posture, stated once:
//  - The catalogue is CLOSED and the queries are FULLY parameterized — the
//    only runtime input is the firm id resolved from the caller's principal.
//    Nothing the model outputs (or the user types) ever reaches SQL.
//  - Every lookup runs inside the caller's own firm scope (ask.ts wraps the
//    call in inClerkScope(firmId), the same RLS posture as the request) AND
//    filters firm_id explicitly, mirroring the route-filter belt-and-braces.
//  - clerk.ask is also held by client_user, but a client asker is only ever
//    OFFERED the CLIENT_SAFE_DATA_INTENTS subset below, and ask.ts FORCES
//    params.clientPartyId to the caller's own party (from the principal,
//    never model output) — so firm-wide numbers never reach a client_user
//    through this surface (SEC-03).
//  - Statuses and reference dates mirror digest.ts / compliance-window.ts —
//    including the Lagos-calendar "today" — so Ask Clerk can never disagree
//    with the dashboards or the weekly digest.

export const DATA_INTENT_PREFIX = "data.";

// Aged-receivables cutoff, in days past due (mirrors the digest fact).
export const RECEIVABLE_AGE_DAYS = 60;

// How many invoice numbers an answer names before summarising the rest.
export const SAMPLE_LIMIT = 5;

export interface DataIntentResult {
  text: string;
  facts: ProtectedFact[];
  // Deterministic open-the-invoice links for the invoices the sample names
  // (round 7): app-built from the SAME rows as the sample, capped the same
  // way, label = invoice number. Absent when the intent's answer names no
  // invoices. The queries below are already firm-scoped (explicit firm_id
  // filter + the caller's inClerkScope RLS posture) and pinned to a client
  // asker's own party by ask.ts (SEC-03), so a link id can never exceed the
  // asker's own visibility.
  links?: ClerkAnswerLink[];
}

// Resolved lookup parameters (idea #4). Every value here is APP-RESOLVED
// from closed enumerated keys the model picked — the model's key selects an
// entry in a map the app built; nothing model-authored reaches SQL.
export interface DataIntentParams {
  // First day of a Lagos calendar month (YYYY-MM-01) + its display label.
  monthStart?: string;
  monthLabel?: string;
  // One of the firm's own client parties (principal-scoped list).
  clientPartyId?: string;
  clientName?: string;
}

export interface DataIntent {
  key: string;
  // Model-facing one-liner in the closed key list (trusted platform text).
  title: string;
  // Which parameters this lookup can honour; a param the model picked for a
  // lookup that cannot honour it refuses rather than silently ignoring it.
  accepts: { month?: boolean; client?: boolean };
  run(firmId: string, params?: DataIntentParams): Promise<DataIntentResult>;
}

// " for Adaeze Foods Ltd" — the client-scope suffix for answer texts.
function forClient(params?: DataIntentParams): string {
  return params?.clientName ? ` for ${params.clientName}` : "";
}

interface InvoiceAggregate {
  count: number;
  totalNgn: string;
  sample: string[];
  // The SAME sample rows with their invoice ids, for answer links. Kept
  // separate from `sample` so the existing sample fact stays byte-identical.
  sampleRows: { id: string; invoiceNumber: string }[];
}

// One round trip per lookup: count + value total + up to SAMPLE_LIMIT invoice
// numbers matching a fixed predicate. `predicate` is always a literal SQL
// fragment from the catalogue below — never constructed from model output —
// and the optional client filter is the app-resolved party id.
async function invoiceAggregate(
  firmId: string,
  predicate: SQL,
  params?: DataIntentParams,
): Promise<InvoiceAggregate> {
  // Per client the filter is supplier-pinned (the client key resolves from
  // the firm's engaged-client list, so orientation is implied); firm-wide,
  // the receivable-orientation predicate keeps captured supplier BILLS —
  // draft forever by design — out of the unsubmitted/overdue answers
  // (payables round). Bills answer through the data.payables_* intents.
  const clientFilter = params?.clientPartyId
    ? sql` AND i.supplier_party_id = ${params.clientPartyId}`
    : sql` AND ${RECEIVABLE_ORIENTATION}`;
  const rows = (
    await getDb().execute<{
      n: number;
      total: string;
      sample: string[] | null;
      sample_rows: { id: string; invoiceNumber: string }[] | null;
    }>(sql`
      WITH hits AS (
        SELECT i.id, i.invoice_number, i.issue_date, i.grand_total
        FROM invoices i
        WHERE i.kind = 'invoice' AND i.firm_id = ${firmId}${clientFilter} AND (${predicate})
      )
      SELECT
        (SELECT COUNT(*) FROM hits)::int AS n,
        (SELECT COALESCE(SUM(grand_total), 0) FROM hits)::text AS total,
        (SELECT COALESCE(array_agg(invoice_number), ARRAY[]::text[]) FROM (
          SELECT invoice_number FROM hits
          ORDER BY issue_date, invoice_number
          LIMIT ${SAMPLE_LIMIT}
        ) s) AS sample,
        (SELECT COALESCE(
          jsonb_agg(
            jsonb_build_object('id', s.id, 'invoiceNumber', s.invoice_number)
            ORDER BY s.issue_date, s.invoice_number
          ),
          '[]'::jsonb
        ) FROM (
          SELECT id, invoice_number, issue_date FROM hits
          ORDER BY issue_date, invoice_number
          LIMIT ${SAMPLE_LIMIT}
        ) s) AS sample_rows
    `)
  ).rows;
  const r = rows[0];
  return {
    count: Number(r?.n ?? 0),
    totalNgn: String(r?.total ?? "0"),
    sample: r?.sample ?? [],
    sampleRows: r?.sample_rows ?? [],
  };
}

// The buyer-side mirror of invoiceAggregate (payables round): count + value
// total + sample over the firm's captured supplier BILLS. Per client the
// filter pins the BUYER side (a bill belongs to the client that must pay
// it); the bill-orientation fragment scopes the firm-wide branch. Same
// closed-catalogue posture: `predicate` is always a literal fragment from
// the catalogue below, never model output. Deliberately NO answer links:
// bills are not invoice-detail linkable for a client asker (the SEC-03
// invoice detail routes are supplier-pinned), so these intents emit none.
async function billAggregate(
  firmId: string,
  predicate: SQL,
  params?: DataIntentParams,
): Promise<InvoiceAggregate> {
  const clientFilter = params?.clientPartyId
    ? sql` AND i.buyer_party_id = ${params.clientPartyId}`
    : sql``;
  const rows = (
    await getDb().execute<{
      n: number;
      total: string;
      sample: string[] | null;
    }>(sql`
      WITH hits AS (
        SELECT i.id, i.invoice_number, i.issue_date, i.grand_total
        FROM invoices i
        WHERE i.kind = 'invoice' AND i.firm_id = ${firmId}
          AND ${BILL_ORIENTATION}${clientFilter} AND (${predicate})
      )
      SELECT
        (SELECT COUNT(*) FROM hits)::int AS n,
        (SELECT COALESCE(SUM(grand_total), 0) FROM hits)::text AS total,
        (SELECT COALESCE(array_agg(invoice_number), ARRAY[]::text[]) FROM (
          SELECT invoice_number FROM hits
          ORDER BY issue_date, invoice_number
          LIMIT ${SAMPLE_LIMIT}
        ) s) AS sample
    `)
  ).rows;
  const r = rows[0];
  return {
    count: Number(r?.n ?? 0),
    totalNgn: String(r?.total ?? "0"),
    sample: r?.sample ?? [],
    sampleRows: [],
  };
}

// Open-the-invoice links built from the aggregate's own sample rows (round
// 7) — the ids come from the SAME firm/SEC-03-scoped query that produced the
// sample, so a link never names an invoice the asker could not already list.
// Spread additively into a DataIntentResult; empty samples carry no links
// key at all, and the sample facts themselves stay byte-identical.
function sampleLinks(agg: InvoiceAggregate): { links?: ClerkAnswerLink[] } {
  if (agg.sampleRows.length === 0) return {};
  return {
    links: agg.sampleRows.slice(0, SAMPLE_LIMIT).map((r) => ({
      label: r.invoiceNumber,
      kind: "invoice" as const,
      id: r.id,
    })),
  };
}

// The chase-list counterpart: per-row invoice ids from listChaseRows /
// firmMoneySummary's topChase — already firm-scoped and (per-client) pinned
// to the asker's own party, like every query in this catalogue.
function chaseLinks(rows: { invoiceId: string; invoiceNumber: string }[]): {
  links?: ClerkAnswerLink[];
} {
  if (rows.length === 0) return {};
  return {
    links: rows.slice(0, SAMPLE_LIMIT).map((r) => ({
      label: r.invoiceNumber,
      kind: "invoice" as const,
      id: r.invoiceId,
    })),
  };
}

// "INV-1, INV-2 and 3 more" — the named sample plus an honest remainder.
function nameSample(agg: InvoiceAggregate): string {
  const rest = agg.count - agg.sample.length;
  return rest > 0
    ? `${agg.sample.join(", ")} and ${rest} more`
    : agg.sample.join(", ");
}

function countFact(key: string, label: string, n: number): ProtectedFact {
  return { key, label, kind: "count", value: String(n) };
}

function invoiceFacts(
  agg: InvoiceAggregate,
  countLabel: string,
  withTotal = false,
): ProtectedFact[] {
  const facts: ProtectedFact[] = [countFact("count", countLabel, agg.count)];
  if (withTotal && agg.count > 0) {
    facts.push({
      key: "total_value",
      label: "Total value",
      kind: "amount",
      value: agg.totalNgn,
      unit: "NGN",
    });
  }
  if (agg.sample.length > 0) {
    facts.push({
      key: "sample",
      label: `Invoice numbers (up to ${SAMPLE_LIMIT})`,
      kind: "text",
      value: agg.sample.join(", "),
    });
  }
  return facts;
}

// The catalogue. Keys are namespaced "data.*" so they can never collide with
// operator-authored claim keys; resolution in ask.ts checks this catalogue
// first, so the platform-defined meaning always wins.
export const DATA_INTENTS: readonly DataIntent[] = [
  {
    key: "data.overdue_submissions",
    title: `invoices past the ${SUBMISSION_WINDOW_DAYS}-day statutory submission window (not yet submitted)`,
    accepts: { client: true },
    async run(firmId, params) {
      // The statutory deadline is Lagos MIDNIGHT STARTING day issue+window
      // (compliance-window.ts submissionDeadline), so an invoice is overdue
      // ON that Lagos day — hence <=, matching the console/SME dashboards
      // and the reminder sweep.
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${lagosTodaySql()}`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} are past the ${SUBMISSION_WINDOW_DAYS}-day submission window. Nothing is overdue today.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} past the ${SUBMISSION_WINDOW_DAYS}-day submission window: ${nameSample(agg)}. Submit these first to limit penalty exposure.`,
        facts: invoiceFacts(agg, "Invoices past the submission window"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.due_soon_submissions",
    title: "invoices whose statutory submission deadline falls in the next 7 days",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int > ${lagosTodaySql()}
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${lagosTodaySql()} + 7`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No submission deadlines${forClient(params)} fall in the next 7 days.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} due for submission within the next 7 days: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Deadlines in the next 7 days"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.failed_submissions",
    title: "invoices whose rail submission failed and needs a fix",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status = 'failed'`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} are currently in a failed submission state.`
            : `${plural(agg.count, "invoice")}${forClient(params)} failed rail submission: ${nameSample(agg)}. Open each invoice for the specific catalogue fix.`,
        facts: invoiceFacts(agg, "Failed submissions"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.unsubmitted_invoices",
    title: "invoices still unsubmitted (sitting in draft or validated)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `Every invoice${forClient(params)} has been submitted — nothing is sitting in draft or validated.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} still unsubmitted (draft or validated): ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Unsubmitted invoices"),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.submitted_this_month",
    title:
      "invoices accepted by the e-invoicing rails in a calendar month (this month unless another listed month is named)",
    accepts: { month: true, client: true },
    async run(firmId, params) {
      // The month window is the app-resolved first-of-month date (Lagos
      // calendar) through the shared lagosWindowSql predicate builder;
      // default = the current Lagos month, exactly as before.
      const monthWindow = params?.monthStart
        ? lagosWindowSql(sql`sa.created_at`, params.monthStart)
        : sql`date_trunc('month', sa.created_at AT TIME ZONE 'Africa/Lagos')
              = date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')`;
      const agg = await invoiceAggregate(
        firmId,
        sql`EXISTS (
          SELECT 1 FROM submission_attempts sa
          WHERE sa.invoice_id = i.id
            AND sa.status = 'accepted'
            AND ${monthWindow}
        )`,
        params,
      );
      const period = params?.monthLabel
        ? `in ${params.monthLabel}`
        : "so far this month";
      return {
        text:
          agg.count === 0
            ? `No invoices${forClient(params)} were accepted by the rails ${period}.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${agg.count === 1 ? "was" : "were"} accepted by the rails ${period}, NGN ${agg.totalNgn} in total: ${nameSample(agg)}.`,
        facts: invoiceFacts(
          agg,
          `Accepted by the rails ${period}`,
          true,
        ),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.aged_receivables",
    title: `receivables more than ${RECEIVABLE_AGE_DAYS} days old (submitted but unpaid)`,
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('submitted', 'stamped', 'confirmed')
          AND COALESCE(i.due_date, i.issue_date) < ${lagosTodaySql()} - ${RECEIVABLE_AGE_DAYS}::int`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No receivables${forClient(params)} are more than ${RECEIVABLE_AGE_DAYS} days old.`
            : `${plural(agg.count, "receivable")}${forClient(params)} ${isAre(agg.count)} more than ${RECEIVABLE_AGE_DAYS} days old, NGN ${agg.totalNgn} in total: ${nameSample(agg)}. Consider chasing payment.`,
        facts: invoiceFacts(agg, `Receivables over ${RECEIVABLE_AGE_DAYS} days`, true),
        ...sampleLinks(agg),
      };
    },
  },
  {
    key: "data.outstanding_receivables",
    title:
      "outstanding receivables — who owes money right now (issued invoices not yet paid)",
    accepts: { client: true },
    async run(firmId, params) {
      // The exported OUTSTANDING fragment in BOTH queries — one spelling of
      // the receivables definition, so this intent and the receivables card
      // cannot drift apart under future edits.
      const agg = await invoiceAggregate(firmId, sql`${OUTSTANDING}`, params);
      // Who owes: top debtors keyed by PARTY (two parties sharing a legal
      // name stay two debtors, matching the receivables card's grouping).
      const clientFilter = params?.clientPartyId
        ? sql` AND i.supplier_party_id = ${params.clientPartyId}`
        : sql``;
      const debtors = (
        await getDb().execute<{ buyer_name: string; owed: string }>(sql`
          SELECT p.legal_name AS buyer_name,
            SUM(i.grand_total)::numeric(18,2)::text AS owed
          FROM invoices i
          JOIN parties p ON p.id = i.buyer_party_id
          WHERE ${OUTSTANDING} AND i.firm_id = ${firmId}${clientFilter}
          GROUP BY i.buyer_party_id, p.legal_name
          ORDER BY SUM(i.grand_total) DESC
          LIMIT 3
        `)
      ).rows;
      const debtorLine =
        debtors.length > 0
          ? ` Top debtors: ${debtors.map((d) => `${d.buyer_name} (NGN ${d.owed})`).join(", ")}.`
          : "";
      return {
        text:
          agg.count === 0
            ? `Nothing is outstanding${forClient(params)} — every issued invoice has been paid or otherwise closed.`
            : `${plural(agg.count, "invoice")}${forClient(params)} ${isAre(agg.count)} outstanding, NGN ${agg.totalNgn} in total.${debtorLine}`,
        facts: [
          ...invoiceFacts(agg, "Outstanding invoices", true),
          ...(debtors.length > 0
            ? [
                {
                  key: "top_debtors",
                  label: "Top debtors",
                  kind: "text" as const,
                  value: debtors
                    .map((d) => `${d.buyer_name}: NGN ${d.owed}`)
                    .join("; "),
                },
              ]
            : []),
        ],
      };
    },
  },
  {
    key: "data.expected_inflows",
    title:
      "money expected to be paid in the coming week, projected from each customer's own payment rhythm",
    accepts: { client: true },
    async run(firmId, params) {
      // Per client: the projections directly; firm-wide: the shared summary
      // (the same numbers the weekly digest phrases).
      if (params?.clientPartyId) {
        const projections = await receivableProjections(
          firmId,
          params.clientPartyId,
        );
        let count = 0;
        let total = 0;
        let late = 0;
        for (const p of projections) {
          if (p.daysBeyondExpected > 0) late += 1;
          else if (p.daysBeyondExpected > -7) {
            count += 1;
            const amount = Number(p.grandTotal);
            if (Number.isFinite(amount)) total += amount;
          }
        }
        return {
          text:
            count === 0
              ? `No payments${forClient(params)} are expected in the coming week${late > 0 ? `, and ${plural(late, "invoice")} ${isAre(late)} already past the expected payment date` : ""}.`
              : `${plural(count, "invoice")}${forClient(params)} totalling NGN ${total.toFixed(2)} ${isAre(count)} expected to be paid in the coming week, based on each customer's own payment rhythm${late > 0 ? `; ${plural(late, "invoice")} ${isAre(late)} already past the expected date` : ""}.`,
          facts: [
            countFact("expected_week", "Expected in the coming week", count),
            {
              key: "expected_week_total",
              label: "Expected value (coming week)",
              kind: "amount",
              value: total.toFixed(2),
              unit: "NGN",
            },
            countFact("past_expected", "Already past expected date", late),
          ],
        };
      }
      const summary = await firmMoneySummary(firmId);
      const scope = summary.truncated
        ? "across your largest client books"
        : "across your clients";
      return {
        text:
          summary.expectedWeekCount === 0
            ? `No payments are expected ${scope} in the coming week${summary.overdueExpectedCount > 0 ? `, and ${plural(summary.overdueExpectedCount, "invoice")} ${isAre(summary.overdueExpectedCount)} already past the expected payment date` : ""}.`
            : `${plural(summary.expectedWeekCount, "invoice")} totalling NGN ${summary.expectedWeekTotalNgn} ${isAre(summary.expectedWeekCount)} expected to be paid ${scope} in the coming week, based on each customer's own payment rhythm${summary.overdueExpectedCount > 0 ? `; ${plural(summary.overdueExpectedCount, "invoice")} ${isAre(summary.overdueExpectedCount)} already past the expected date` : ""}.`,
        facts: [
          countFact(
            "expected_week",
            "Expected in the coming week",
            summary.expectedWeekCount,
          ),
          {
            key: "expected_week_total",
            label: "Expected value (coming week)",
            kind: "amount",
            value: summary.expectedWeekTotalNgn,
            unit: "NGN",
          },
          countFact(
            "past_expected",
            "Already past expected date",
            summary.overdueExpectedCount,
          ),
        ],
      };
    },
  },
  {
    key: "data.chase_list",
    title:
      "which unpaid invoices are most worth chasing (past both the due date and the customer's usual payment rhythm)",
    accepts: { client: true },
    async run(firmId, params) {
      const nameRows = (
        rows: { buyerName: string; invoiceNumber: string; daysBeyondExpected: number }[],
      ) =>
        rows
          .slice(0, 3)
          .map(
            (r) =>
              `${r.buyerName} — ${r.invoiceNumber} (${r.daysBeyondExpected}d beyond expectation)`,
          )
          .join("; ");
      if (params?.clientPartyId) {
        // The COUNT comes from the uncapped, all-currency projections via
        // the shared eligibility predicate — the display list (primary
        // currency, capped) only supplies the named rows, so the number
        // presented as definitive never inherits a display cap.
        const projections = await receivableProjections(
          firmId,
          params.clientPartyId,
        );
        const today = lagosDateString();
        const eligible = projections.filter((p) =>
          isChaseEligible(p, today),
        ).length;
        const rows = await listChaseRows(firmId, params.clientPartyId);
        return {
          text:
            eligible === 0
              ? `Nothing${forClient(params)} is currently worth chasing — no invoice is past both its due date and the customer's usual payment rhythm.`
              : `${plural(eligible, "invoice")}${forClient(params)} ${isAre(eligible)} worth chasing: ${nameRows(rows)}. Open an invoice to draft a payment reminder.`,
          facts: [countFact("chase_count", "Worth chasing", eligible)],
          ...chaseLinks(rows),
        };
      }
      const summary = await firmMoneySummary(firmId);
      const scope = summary.truncated
        ? "across your largest client books"
        : "across your clients";
      return {
        text:
          summary.chaseCount === 0
            ? `Nothing ${scope} is currently worth chasing — no invoice is past both its due date and the customer's usual payment rhythm.`
            : `${plural(summary.chaseCount, "invoice")} ${scope} ${isAre(summary.chaseCount)} worth chasing: ${nameRows(
                summary.topChase.map((r) => ({
                  ...r,
                  buyerName: `${r.buyerName} (${r.clientName})`,
                })),
              )}.`,
        facts: [countFact("chase_count", "Worth chasing", summary.chaseCount)],
        ...chaseLinks(summary.topChase),
      };
    },
  },
  {
    key: "data.payables_due",
    title:
      "supplier bills due within the next 7 days or already overdue (unpaid captured vendor invoices)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await billAggregate(
        firmId,
        sql`${BILL_UNPAID}
          AND i.due_date IS NOT NULL
          AND i.due_date <= ${lagosTodaySql()} + 7`,
        params,
      );
      return {
        text:
          agg.count === 0
            ? `No supplier bills${forClient(params)} are due within the next 7 days or overdue.`
            : `${plural(agg.count, "supplier bill")}${forClient(params)} ${isAre(agg.count)} due within the next 7 days or already overdue, NGN ${agg.totalNgn} in total: ${nameSample(agg)}. Worth scheduling the payments.`,
        facts: invoiceFacts(agg, "Bills due within 7 days or overdue", true),
        // No links (see billAggregate): bill rows are not invoice-detail
        // linkable for a client asker.
      };
    },
  },
  {
    key: "data.total_owed",
    title:
      "the total owed to suppliers right now (unpaid captured vendor bills, whatever their due date)",
    accepts: { client: true },
    async run(firmId, params) {
      const agg = await billAggregate(firmId, sql`${BILL_UNPAID}`, params);
      return {
        text:
          agg.count === 0
            ? `Nothing is owed to suppliers${forClient(params)} — every captured bill has payment evidence.`
            : `${plural(agg.count, "supplier bill")}${forClient(params)} ${isAre(agg.count)} unpaid, NGN ${agg.totalNgn} owed in total: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Unpaid supplier bills", true),
        // No links (see billAggregate).
      };
    },
  },
  {
    key: "data.clerk_allowance",
    title: "the firm's Clerk AI token allowance and usage this month",
    accepts: {},
    async run(firmId) {
      const usage = await firmClerkUsage(firmId);
      const remaining = Math.max(0, usage.budgetTokens - usage.usedTokens);
      return {
        text: `Your firm has used ${usage.usedTokens} of its ${usage.budgetTokens} monthly Clerk tokens (${remaining} remaining). The allowance resets at the start of each calendar month.`,
        facts: [
          {
            key: "used_tokens",
            label: "Tokens used this month",
            kind: "count",
            value: String(usage.usedTokens),
            unit: "tokens",
          },
          {
            key: "budget_tokens",
            label: "Monthly allowance",
            kind: "count",
            value: String(usage.budgetTokens),
            unit: "tokens",
          },
          {
            key: "remaining_tokens",
            label: "Remaining",
            kind: "count",
            value: String(remaining),
            unit: "tokens",
          },
        ],
      };
    },
  },
];

// Client-facing Ask (SEC-03). clerk.ask is open to client_users, but the
// firm's numbers are not: a client asker is only ever OFFERED intents whose
// ENTIRE answer survives a forced own-party filter — ask.ts pins
// params.clientPartyId to the principal's own party before any of these run,
// so every one of them reduces to invoiceAggregate over the caller's own
// invoices. ALLOWLIST by construction: a future intent stays invisible to
// clients until it is vetted and added here. Excluded intents, each with the
// firm-wide content its answer embeds:
//  - data.outstanding_receivables: embeds a top-debtor ranking (its
//    firm-wide branch ranks the whole client book);
//  - data.expected_inflows: its firm-wide branch phrases firmMoneySummary
//    across every client's receivables;
//  - data.chase_list: its firm-wide branch names OTHER clients and their
//    buyers in the chase rows;
//  - data.clerk_allowance: the FIRM's monthly token budget and spend —
//    firm-internal billing, not a client's own records.
// A client question that wants an excluded intent hits the ordinary refusal
// machinery (the closed enum never offered the key) — never a firm-wide
// answer.
const CLIENT_SAFE_INTENT_KEYS: ReadonlySet<string> = new Set([
  "data.overdue_submissions",
  "data.due_soon_submissions",
  "data.failed_submissions",
  "data.unsubmitted_invoices",
  "data.submitted_this_month",
  // Pure invoiceAggregate with the client predicate, exactly like the five
  // above — no firm-wide content anywhere in its answer.
  "data.aged_receivables",
  // Buyer-side billAggregate with the forced own-party pin on the BUYER
  // column — a client asker only ever sees its own bills, and the answers
  // deliberately carry no links (bill rows are not invoice-detail linkable
  // for clients).
  "data.payables_due",
  "data.total_owed",
]);

export const CLIENT_SAFE_DATA_INTENTS: readonly DataIntent[] =
  DATA_INTENTS.filter((i) => CLIENT_SAFE_INTENT_KEYS.has(i.key));

// The closed month options offered to the classifier: the current Lagos
// month plus the eleven before it. Keys are "YYYY-MM"; the app resolves a
// picked key back through THIS list (never the model's text).
export interface MonthOption {
  key: string;
  label: string;
  monthStart: string; // YYYY-MM-01
}

export function lagosMonthOptions(count = 12, now = new Date()): MonthOption[] {
  const { year, monthIndex } = lagosParts(now);
  return Array.from({ length: count }, (_, i) => {
    // Date.UTC-style overflow carries negative months into prior years.
    const d = new Date(Date.UTC(year, monthIndex - i, 1));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const mm = String(m + 1).padStart(2, "0");
    return {
      key: `${y}-${mm}`,
      label: `${MONTH_NAMES[m]} ${y}${i === 0 ? " (current month)" : ""}`,
      monthStart: `${y}-${mm}-01`,
    };
  });
}

const BY_KEY = new Map(DATA_INTENTS.map((i) => [i.key, i]));

export function getDataIntent(key: string): DataIntent | undefined {
  return BY_KEY.get(key);
}

// Run one lookup for one firm. Callers provide the firm scope (ask.ts wraps
// this in inClerkScope(firmId)); unknown keys resolve to null so the caller
// refuses fail-closed rather than guessing.
export async function runDataIntent(
  key: string,
  firmId: string,
  params?: DataIntentParams,
): Promise<DataIntentResult | null> {
  const intent = BY_KEY.get(key);
  if (!intent) return null;
  return intent.run(firmId, params);
}
