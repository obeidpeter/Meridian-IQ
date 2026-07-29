import { sql, type SQL } from "drizzle-orm";
import { getDb, type ClerkAnswerLink, type ProtectedFact } from "@workspace/db";
import {
  BILL_ORIENTATION,
  RECEIVABLE_ORIENTATION,
} from "../../invoice/receivables";

// The data-intent catalogue's shared spine: the closed-catalogue types, the
// deterministic invoice-number extractor, and the parameterized aggregate
// helpers every group file composes. Nothing here runs a lookup on its own —
// the catalogue lives in the sibling group files, composed by index.ts.

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
  // APP-EXTRACTED from the raw question by extractInvoiceNumbers (a regex,
  // never the model) — the round-20 invoice-pinned lookup's key. Compared
  // case-insensitively against the firm's own invoice numbers; it reaches
  // SQL only as a bound parameter.
  invoiceNumber?: string;
}

// Deterministic invoice-number extraction (round-20 idea: "what's happening
// with INV-2041?"). The model never touches this — ask.ts runs it over the
// RAW question when the classifier picks data.invoice_status. Two shapes:
// a token with an internal separator and a digit (INV-2041, 2026/044), and
// a bare number introduced by an invoice-ish word or # ("invoice 7801").
// Pure and exported for tests. Date-shaped tokens are excluded — "2026-07-08"
// is a date in a question, not an invoice number.
const SEPARATED_TOKEN_RE = /\b[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+)+\b/g;
// Letter-prefixed compounds with no separator (INV2041) — without this
// class, "invoice INV2041" would extract the bare "2041" via the intro
// pattern and then honestly find nothing.
const COMPOUND_TOKEN_RE = /\b[A-Za-z]{2,}\d{3,}\b/g;
// The word alternation needs \b (or "casino 12345" mints via its "no"
// tail) and "no" needs its dot (or the ordinary word "no" introduces any
// number); "#" is non-word, so it gets its own boundary-free arm.
const INTRODUCED_NUMBER_RE =
  /(?:\b(?:invoice|inv|bill|number|no\.)|#)\s*[#:]?\s*(\d{3,})/gi;
const DATE_SHAPES = [
  /^\d{4}-\d{1,2}(-\d{1,2})?$/,
  /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/,
  /^\d{4}[/-]\d{1,2}([/-]\d{1,2})?$/, // 2026/07/08, 2026/07, 2025/26 (fiscal)
  /^\d{1,2}[/-]\d{4}$/, // 05/2026
];
// A token introduced by one of these words is that thing, not an invoice
// number — the rail error code and TIN false positives the review probed.
// The leading \b keeps word TAILS out ("Eko Hotel INV-2041" must not lose
// its number to the "tel" of "Hotel").
const EXCLUDING_CONTEXT_RE = /\b(?:code|error|tin|phone|tel|call)[\s:#-]*$/i;
// A compound whose letters are a period word is a period, not a number
// (FY2025, Q32026, July2026).
const PERIOD_COMPOUND_RE =
  /^(?:fy|q\d?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun[e]?|jul[y]?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\d+$/i;

export function extractInvoiceNumbers(question: string): string[] {
  const seen = new Map<string, string>(); // lower -> first-seen casing
  const consider = (token: string, index: number) => {
    if (!/\d/.test(token)) return;
    if (DATE_SHAPES.some((re) => re.test(token))) return;
    if (EXCLUDING_CONTEXT_RE.test(question.slice(Math.max(0, index - 12), index)))
      return;
    const key = token.toLowerCase();
    if (!seen.has(key)) seen.set(key, token);
  };
  for (const m of question.matchAll(SEPARATED_TOKEN_RE)) {
    consider(m[0], m.index ?? 0);
  }
  for (const m of question.matchAll(COMPOUND_TOKEN_RE)) {
    if (PERIOD_COMPOUND_RE.test(m[0])) continue;
    // A compound inside a separated token (the "TIN" of "IS-TIN-01") was
    // already considered as its whole token.
    if ([...seen.keys()].some((k) => k.includes(m[0].toLowerCase()))) continue;
    consider(m[0], m.index ?? 0);
  }
  // The digit TAILS of already-found candidates: an introduced bare number
  // equal to one ("invoice INV2041" → "2041") is not a second candidate —
  // but exact-tail only, never substring (the review-confirmed N1: "invoice
  // 123" beside "INV-1234" is a DIFFERENT invoice and must surface both,
  // which then refuses honestly rather than silently answering about one).
  const seenTails = new Set(
    [...seen.keys()]
      .map((k) => /(\d+)$/.exec(k)?.[1])
      .filter((t): t is string => t !== undefined),
  );
  for (const m of question.matchAll(INTRODUCED_NUMBER_RE)) {
    const key = m[1].toLowerCase();
    if (seenTails.has(key)) continue;
    if (!seen.has(key)) seen.set(key, m[1]);
  }
  return [...seen.values()];
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
export function forClient(params?: DataIntentParams): string {
  return params?.clientName ? ` for ${params.clientName}` : "";
}

export interface InvoiceAggregate {
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
export async function invoiceAggregate(
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
export async function billAggregate(
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
export function sampleLinks(agg: InvoiceAggregate): { links?: ClerkAnswerLink[] } {
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
export function chaseLinks(rows: { invoiceId: string; invoiceNumber: string }[]): {
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
export function nameSample(agg: InvoiceAggregate): string {
  const rest = agg.count - agg.sample.length;
  return rest > 0
    ? `${agg.sample.join(", ")} and ${rest} more`
    : agg.sample.join(", ");
}

export function countFact(key: string, label: string, n: number): ProtectedFact {
  return { key, label, kind: "count", value: String(n) };
}

export function invoiceFacts(
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
