import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosTodaySql } from "../../../lib/lagos-time";
import {
  SUBMISSION_WINDOW_DAYS,
  UNSUBMITTED_STATE,
  daysPastDeadline,
  pastSubmissionDeadline,
} from "../../invoice/compliance-window";
import {
  BILL_ORIENTATION,
  RECEIVABLE_ORIENTATION,
} from "../../invoice/receivables";
import { SETTLEMENT_EVIDENCE } from "../../invoice/payables";
import { pendingApprovals } from "../../invoice/approvals";
import { listActionProposals } from "../actions";
import { firmClerkUsage } from "../budget";
import { isAre, plural } from "../text";
import { type DataIntent, countFact, forClient } from "./shared";

// The status lookups — one pinned invoice, maker-checker waits, the Clerk
// allowance, and the proposed-action batches waiting for approval.
export const STATUS_INTENTS: readonly DataIntent[] = [
  {
    // Round-20 invoice-pinned lookup: one specific invoice's status and
    // next step. The invoice number is APP-EXTRACTED from the question
    // (extractInvoiceNumbers — ask.ts refuses when none or several appear);
    // the model only picks this key. A client asker's pin matches EITHER
    // side of the paper (their receivable or their captured bill).
    key: "data.invoice_status",
    title:
      "the current status and next step for ONE SPECIFIC invoice the question names by its invoice number",
    accepts: { client: true },
    async run(firmId, params) {
      const number = params?.invoiceNumber;
      if (!number) {
        // ask.ts guarantees the number; fail closed if it ever doesn't.
        return {
          text: "No invoice number reached the lookup, so it cannot answer. Name the invoice number exactly as it appears and ask again.",
          facts: [],
        };
      }
      // SEC-03 (review-confirmed H1): the pin's buyer arm is qualified with
      // BILL_ORIENTATION — the bills scope wall verbatim. Without it, a
      // client who happens to be the BUYER on a sibling client's receivable
      // (dual-engaged trades are supported; the supplier side wins
      // orientation) could read the sibling's rail posture. With it, a
      // pinned asker only ever matches their own receivables or rows that
      // actually ARE their captured bills; a sibling's paper answers "no
      // invoice" — non-disclosure.
      const clientFilter = params?.clientPartyId
        ? sql` AND (i.supplier_party_id = ${params.clientPartyId} OR (i.buyer_party_id = ${params.clientPartyId} AND ${BILL_ORIENTATION}))`
        : sql``;
      const rows = (
        await getDb().execute<{
          id: string;
          invoice_number: string;
          status: string;
          issue_date: string;
          currency: string;
          grand_total: string | null;
          recv: boolean;
          bill: boolean;
          overdue: boolean;
          days_over: number | null;
          settled: boolean;
          last_error: string | null;
        }>(sql`
          SELECT i.id, i.invoice_number, i.status, i.issue_date::text AS issue_date,
            i.currency, i.grand_total::text AS grand_total,
            (${RECEIVABLE_ORIENTATION}) AS recv,
            (${BILL_ORIENTATION}) AS bill,
            (${UNSUBMITTED_STATE}
              AND ${pastSubmissionDeadline(lagosTodaySql())}) AS overdue,
            ${daysPastDeadline(lagosTodaySql())} AS days_over,
            EXISTS (
              SELECT 1 FROM settlement_events se
              WHERE se.invoice_id = i.id
                AND ${SETTLEMENT_EVIDENCE}
            ) AS settled,
            (SELECT sa.error_code FROM submission_attempts sa
              WHERE sa.invoice_id = i.id AND sa.status IN ('rejected', 'error')
              ORDER BY sa.created_at DESC LIMIT 1) AS last_error
          FROM invoices i
          WHERE i.firm_id = ${firmId}
            AND i.kind = 'invoice'
            AND LOWER(i.invoice_number) = LOWER(${number})${clientFilter}
          LIMIT 4
        `)
      ).rows;
      if (rows.length === 0) {
        return {
          text: `No invoice numbered ${number}${forClient(params)} exists in the records the platform holds. Check the number and ask again.`,
          facts: [countFact("matches", "Matching invoices", 0)],
        };
      }
      if (rows.length > 1) {
        // LIMIT 4 means "4" may understate; a pinned asker's duplicates
        // can only be their OWN paper (the pin above), so the firm-wide
        // "name the client" advice would be useless there.
        const shown = rows.length >= 4 ? "4 or more" : String(rows.length);
        return {
          text: params?.clientPartyId
            ? `${shown} of your own documents share the number ${number} — one may be your invoice and another a captured supplier bill. Open the invoices or bills page to pick the right one.`
            : `${shown} invoices share the number ${number} across the firm's clients. Add the client's name to the question to pick one.`,
          facts: [countFact("matches", "Matching invoices", rows.length)],
        };
      }
      const r = rows[0];
      const side = r.bill
        ? "a captured supplier bill (money going out)"
        : r.recv
          ? "a receivable e-invoice (money coming in)"
          : "an invoice with no engaged side";
      // The next step per posture — the status-light vocabulary, one line.
      const next = r.bill
        ? r.settled
          ? "Payment evidence is on file — nothing to do."
          : "No payment evidence yet — flag or reconcile the payment when it is made, and verify the supplier's stamp for input VAT."
        : r.status === "failed" && r.last_error
          ? `Its last submission failed with code ${r.last_error} — open the invoice for the catalogue fix, then resubmit.`
          : r.status === "failed"
            ? "Its last submission failed — open the invoice for the specific fix, then resubmit."
            : r.overdue
              ? Number(r.days_over ?? 0) <= 0
                ? `It reached its ${SUBMISSION_WINDOW_DAYS}-day submission deadline today — submit it now to limit penalty exposure.`
                : `It is ${plural(Number(r.days_over), "day")} past the ${SUBMISSION_WINDOW_DAYS}-day submission window — submit it now to limit penalty exposure.`
              : r.status === "draft" || r.status === "validated"
                ? "It has not been submitted — validate and submit it inside the statutory window."
                : r.status === "submitted"
                  ? "It is with the rails awaiting a verdict — no action needed yet."
                  : r.status === "stamped" && r.settled
                    ? "It is stamped and payment evidence is on file — fully done."
                    : r.status === "stamped"
                      ? "It is stamped; no payment evidence yet — chase or reconcile the payment when it arrives."
                      : `Its status is ${r.status} — no further action from here.`;
      return {
        text: `Invoice ${r.invoice_number}${forClient(params)} is ${side}, issued ${r.issue_date}, status ${r.status}. ${next}`,
        facts: [
          { key: "number", label: "Invoice number", kind: "text", value: r.invoice_number },
          { key: "status", label: "Status", kind: "text", value: r.status },
          ...(r.grand_total !== null
            ? [
                {
                  key: "amount",
                  label: "Amount",
                  kind: "amount" as const,
                  value: r.grand_total,
                  unit: r.currency,
                },
              ]
            : []),
        ],
        // No link for a pinned asker's BILL: the SME app routes invoice
        // links through the supplier-side detail loader, which correctly
        // 403s the buyer — a link that always dead-ends is worse than none
        // (the bills page shows the document).
        ...(r.bill && params?.clientPartyId
          ? {}
          : {
              links: [
                { label: r.invoice_number, kind: "invoice" as const, id: r.id },
              ],
            }),
      };
    },
  },
  {
    key: "data.pending_approvals",
    title:
      "invoices waiting for a colleague's submission approval under the firm's maker-checker policy (count, oldest wait, the waiting invoices)",
    accepts: { client: true },
    async run(firmId, params) {
      const pending = await pendingApprovals(firmId, params?.clientPartyId);
      // Policy off is its own honest answer — "0 waiting" and "the firm
      // doesn't use approvals" must never read the same, in the TEXT and in
      // the machine-readable facts alike (no zero-count fact here).
      if (pending === null) {
        return {
          text: "This firm has not turned on submission approvals, so no invoice waits on a second approver.",
          facts: [],
        };
      }
      if (pending.count === 0) {
        return {
          text: `No invoices${forClient(params)} are waiting for a submission approval right now.`,
          facts: [countFact("pending_approvals", "Awaiting approval", 0)],
        };
      }
      const sample = pending.invoices.map((r) => r.invoiceNumber).join(", ");
      const more = pending.count - pending.invoices.length;
      return {
        text:
          `${plural(pending.count, "invoice")}${forClient(params)} ${isAre(pending.count)} waiting for a colleague's approval before submission` +
          `${pending.oldestDays !== null && pending.oldestDays > 0 ? ` (oldest waiting ${plural(pending.oldestDays, "day")})` : ""}: ` +
          `${sample}${more > 0 ? ` and ${more} more` : ""}.`,
        facts: [
          countFact("pending_approvals", "Awaiting approval", pending.count),
          ...(pending.oldestDays !== null
            ? [countFact("oldest_wait_days", "Oldest wait (days)", pending.oldestDays)]
            : []),
        ],
        links: pending.invoices.map((r) => ({
          label: r.invoiceNumber,
          kind: "invoice" as const,
          id: r.invoiceId,
        })),
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
  {
    // Round-22 arc awareness: what Clerk stands ready to DO. The lookup
    // runs the SAME live proposal assembly as the dashboard cards
    // (flag-gated, fail-closed — a dark clerk_actions flag answers "none
    // waiting"), and the answer only POINTS at the approval surface: Ask
    // can never execute anything.
    key: "data.proposed_actions",
    title:
      "the action batches Clerk has assembled and is WAITING FOR APPROVAL on (submit overdue paper, retry failed submissions, draft payment reminders) — what Clerk could do next, not a status report",
    accepts: { client: true },
    async run(firmId, params) {
      if (!params?.clientPartyId) {
        return {
          text: "Clerk assembles action batches per client — name the client you mean and I will check what is waiting for approval.",
          facts: [countFact("proposed_actions", "Batches ready", 0)],
        };
      }
      const { actions } = await listActionProposals(
        firmId,
        params.clientPartyId,
      );
      if (actions.length === 0) {
        return {
          text: `Clerk has no action batches waiting for approval${forClient(params)} right now — nothing is currently overdue, failed or chase-worthy enough to batch (or the proposed-actions surface is not enabled for this firm).`,
          facts: [countFact("proposed_actions", "Batches ready", 0)],
        };
      }
      const lines = actions.map(
        (a) => `"${a.title}" (${plural(a.targetCount, "invoice")})`,
      );
      return {
        text:
          `Clerk has ${actions.length === 1 ? "1 action batch" : `${actions.length} action batches`} assembled and waiting for approval${forClient(params)}: ${lines.join("; ")}. ` +
          `Nothing runs until a person approves it on the dashboard — every target is re-checked at that moment, and the decision is recorded.`,
        facts: [
          countFact("proposed_actions", "Batches ready", actions.length),
          ...actions.map((a) =>
            countFact(`targets_${a.kind}`, a.title, a.targetCount),
          ),
        ],
      };
    },
  }
];
