import { lagosParts } from "../../../lib/lagos-time";
import { MONTH_NAMES } from "../text";
import { type DataIntent, type DataIntentParams, type DataIntentResult } from "./shared";
import { SUBMISSION_INTENTS } from "./submissions";
import { MONEY_INTENTS } from "./money";
import { PAYABLES_INTENTS } from "./payables";
import { FILING_INTENTS } from "./filing";
import { STATUS_INTENTS } from "./status";
import { DELTA_INTENTS } from "./deltas";
import { OBLIGATION_INTENTS } from "./obligations";

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
//
// The catalogue is split by concern (the routes/clerk pattern) — each group
// file is a CONTIGUOUS slice of the original single-file array, composed
// below in the original order (the order is part of the model-facing key
// list, so it must stay stable):
//   shared.ts       types, the invoice-number extractor, aggregate helpers
//   submissions.ts  the five statutory submission clocks
//   money.ts        receivables, expected inflows, the chase list
//   payables.ts     supplier bills due, total owed
//   filing.ts       VAT position, penalty exposure
//   status.ts       one pinned invoice, approvals, allowance, proposed actions
//   deltas.ts       month-over-month comparison, per-client movers (Ask 2.0)
//   obligations.ts  open authority obligations (Notice Desk)

// The catalogue. Keys are namespaced "data.*" so they can never collide with
// operator-authored claim keys; resolution in ask.ts checks this catalogue
// first, so the platform-defined meaning always wins. The order is
// MODEL-FACING (it is the key-list order every classifier prompt renders and
// the eval corpus freezes) — APPEND ONLY: new groups join at the END, never
// between existing ones.
export const DATA_INTENTS: readonly DataIntent[] = [
  ...SUBMISSION_INTENTS,
  ...MONEY_INTENTS,
  ...PAYABLES_INTENTS,
  ...FILING_INTENTS,
  ...STATUS_INTENTS,
  ...DELTA_INTENTS,
  // APPEND ONLY: the Notice Desk group joins at the END (the key-list order
  // is model-facing and frozen by the eval corpus).
  ...OBLIGATION_INTENTS,
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
  // VAT position with the forced own-party pin: ask.ts always sets
  // params.clientPartyId for a client asker, so only the per-client branch
  // (computeVatPosition over the caller's own documents) is reachable — the
  // firm-wide totals branch never runs for a client. Linkless like the two
  // payables keys above, for the same bills-are-not-linkable reason.
  "data.vat_position",
  // Awaiting-approval with the forced own-party pin: the waiting invoices
  // are the caller's OWN receivable drafts (supplier-pinned, so the links
  // stay inside the asker's SEC-03 visibility); the policy state itself is
  // firm configuration a client may fairly learn — it blocks their paper.
  "data.pending_approvals",
  // Penalty exposure with the forced own-party pin: the overdue paper and
  // its links are the caller's own supplier-pinned invoices, and the rates
  // are MeridianIQ's published public model — nothing firm-internal.
  "data.penalty_exposure",
  // Invoice-pinned status with the forced own-party pin: the lookup only
  // matches invoices where the caller's party sits on EITHER side, so a
  // sibling's invoice number answers "no invoice numbered X" — the bills
  // scope wall's non-disclosure posture. The single link is the caller's
  // own paper.
  "data.invoice_status",
  // Proposed actions with the forced own-party pin: the batches are
  // assembled over the caller's OWN paper (the same per-client assembly the
  // SME dashboard card runs), titles and counts only — no other client is
  // ever named, and the answer cannot execute anything.
  "data.proposed_actions",
  // Standing approvals with the forced own-party pin: the grants read are
  // the caller's OWN client's (listActionPolicies is (firm, party)-scoped),
  // status words are app-computed, and the answer only points at the
  // Automation strip — Ask can never grant, pause or revoke anything.
  "data.automation_status",
  // Month-over-month comparison with the forced own-party pin: every side
  // reduces to an own-party one-home — invoiceAggregate pins the supplier
  // side, billAggregate the buyer side, and the VAT pair runs
  // computeVatPosition over the caller's own documents (the firm-wide
  // totals branch is unreachable under the pin). Linkless like the payables
  // and VAT keys above, for the same bills-are-not-linkable reason.
  // data.client_breakdown is deliberately ABSENT: it ranks the firm's
  // clients against each other — firm-wide content by definition.
  "data.month_delta",
  // Open obligations with the forced own-party pin: accepts.client is true
  // and countOpenObligations reduces to the caller's OWN notices under the
  // pin — counts and a date only, no other client is ever named, and the
  // answer carries no links at all.
  "data.open_obligations",
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

// The current-month marker's one home: minted onto the leading option's
// label below, stripped at answer time (ask.ts stores dataParams labels in
// the stripped form) — stripCurrentMonth is the one spelling of that strip.
export const CURRENT_MONTH_SUFFIX = " (current month)";

export function stripCurrentMonth(label: string): string {
  return label.replace(CURRENT_MONTH_SUFFIX, "");
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
      label: `${MONTH_NAMES[m]} ${y}${i === 0 ? CURRENT_MONTH_SUFFIX : ""}`,
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

export {
  DATA_INTENT_PREFIX,
  RECEIVABLE_AGE_DAYS,
  SAMPLE_LIMIT,
  extractInvoiceNumbers,
  type DataIntent,
  type DataIntentParams,
  type DataIntentResult,
} from "./shared";
