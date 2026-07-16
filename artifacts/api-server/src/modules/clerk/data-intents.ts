import { sql, type SQL } from "drizzle-orm";
import { getDb, type ProtectedFact } from "@workspace/db";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
import { firmClerkUsage } from "./budget";

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
//  - clerk.ask is a firm_admin/firm_staff/operator capability, so firm-wide
//    numbers never reach a client_user through this surface (SEC-03).
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
}

export interface DataIntent {
  key: string;
  // Model-facing one-liner in the closed key list (trusted platform text).
  title: string;
  run(firmId: string): Promise<DataIntentResult>;
}

const LAGOS_TODAY = sql`(now() AT TIME ZONE 'Africa/Lagos')::date`;

interface InvoiceAggregate {
  count: number;
  totalNgn: string;
  sample: string[];
}

// One round trip per lookup: count + value total + up to SAMPLE_LIMIT invoice
// numbers matching a fixed predicate. `predicate` is always a literal SQL
// fragment from the catalogue below — never constructed from model output.
async function invoiceAggregate(
  firmId: string,
  predicate: SQL,
): Promise<InvoiceAggregate> {
  const rows = (
    await getDb().execute<{
      n: number;
      total: string;
      sample: string[] | null;
    }>(sql`
      WITH hits AS (
        SELECT i.invoice_number, i.issue_date, i.grand_total
        FROM invoices i
        WHERE i.kind = 'invoice' AND i.firm_id = ${firmId} AND (${predicate})
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
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function isAre(n: number): string {
  return n === 1 ? "is" : "are";
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
    async run(firmId) {
      // The statutory deadline is Lagos MIDNIGHT STARTING day issue+window
      // (compliance-window.ts submissionDeadline), so an invoice is overdue
      // ON that Lagos day — hence <=, matching the console/SME dashboards
      // and the reminder sweep.
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${LAGOS_TODAY}`,
      );
      return {
        text:
          agg.count === 0
            ? `No invoices are past the ${SUBMISSION_WINDOW_DAYS}-day submission window. Nothing is overdue today.`
            : `${plural(agg.count, "invoice")} ${isAre(agg.count)} past the ${SUBMISSION_WINDOW_DAYS}-day submission window: ${nameSample(agg)}. Submit these first to limit penalty exposure.`,
        facts: invoiceFacts(agg, "Invoices past the submission window"),
      };
    },
  },
  {
    key: "data.due_soon_submissions",
    title: "invoices whose statutory submission deadline falls in the next 7 days",
    async run(firmId) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int > ${LAGOS_TODAY}
          AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${LAGOS_TODAY} + 7`,
      );
      return {
        text:
          agg.count === 0
            ? "No submission deadlines fall in the next 7 days."
            : `${plural(agg.count, "invoice")} ${isAre(agg.count)} due for submission within the next 7 days: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Deadlines in the next 7 days"),
      };
    },
  },
  {
    key: "data.failed_submissions",
    title: "invoices whose rail submission failed and needs a fix",
    async run(firmId) {
      const agg = await invoiceAggregate(firmId, sql`i.status = 'failed'`);
      return {
        text:
          agg.count === 0
            ? "No invoices are currently in a failed submission state."
            : `${plural(agg.count, "invoice")} failed rail submission: ${nameSample(agg)}. Open each invoice for the specific catalogue fix.`,
        facts: invoiceFacts(agg, "Failed submissions"),
      };
    },
  },
  {
    key: "data.unsubmitted_invoices",
    title: "invoices still unsubmitted (sitting in draft or validated)",
    async run(firmId) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('draft', 'validated')`,
      );
      return {
        text:
          agg.count === 0
            ? "Every invoice has been submitted — nothing is sitting in draft or validated."
            : `${plural(agg.count, "invoice")} ${isAre(agg.count)} still unsubmitted (draft or validated): ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Unsubmitted invoices"),
      };
    },
  },
  {
    key: "data.submitted_this_month",
    title: "invoices accepted by the e-invoicing rails so far this calendar month",
    async run(firmId) {
      const agg = await invoiceAggregate(
        firmId,
        sql`EXISTS (
          SELECT 1 FROM submission_attempts sa
          WHERE sa.invoice_id = i.id
            AND sa.status = 'accepted'
            AND date_trunc('month', sa.created_at AT TIME ZONE 'Africa/Lagos')
              = date_trunc('month', now() AT TIME ZONE 'Africa/Lagos')
        )`,
      );
      return {
        text:
          agg.count === 0
            ? "No invoices have been accepted by the rails so far this month."
            : `${plural(agg.count, "invoice")} ${agg.count === 1 ? "was" : "were"} accepted by the rails so far this month, NGN ${agg.totalNgn} in total: ${nameSample(agg)}.`,
        facts: invoiceFacts(agg, "Accepted by the rails this month", true),
      };
    },
  },
  {
    key: "data.aged_receivables",
    title: `receivables more than ${RECEIVABLE_AGE_DAYS} days old (submitted but unpaid)`,
    async run(firmId) {
      const agg = await invoiceAggregate(
        firmId,
        sql`i.status IN ('submitted', 'stamped', 'confirmed')
          AND COALESCE(i.due_date, i.issue_date) < ${LAGOS_TODAY} - ${RECEIVABLE_AGE_DAYS}::int`,
      );
      return {
        text:
          agg.count === 0
            ? `No receivables are more than ${RECEIVABLE_AGE_DAYS} days old.`
            : `${plural(agg.count, "receivable")} ${isAre(agg.count)} more than ${RECEIVABLE_AGE_DAYS} days old, NGN ${agg.totalNgn} in total: ${nameSample(agg)}. Consider chasing payment.`,
        facts: invoiceFacts(agg, `Receivables over ${RECEIVABLE_AGE_DAYS} days`, true),
      };
    },
  },
  {
    key: "data.clerk_allowance",
    title: "the firm's Clerk AI token allowance and usage this month",
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
): Promise<DataIntentResult | null> {
  const intent = BY_KEY.get(key);
  if (!intent) return null;
  return intent.run(firmId);
}
