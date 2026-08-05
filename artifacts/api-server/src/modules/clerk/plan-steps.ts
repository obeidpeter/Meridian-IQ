import { asc, inArray } from "drizzle-orm";
import { getDb, runRequestContext, invoiceLinesTable } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import {
  buyerBillingHistories,
} from "../invoice/recurring-suggest";
import { unbilledAlertFor } from "../invoice/unbilled-income";
import { createDraft } from "../invoice/service";
import type { LineInput } from "../invoice/lines";
import { logger } from "../../lib/logger";

// Close with Clerk Phase 1 (round 34): DETERMINISTIC plan-step kinds — the
// second step class beside the action catalogue. An action step drives
// executeAction and writes a decision-ledger row per batch; a deterministic
// step is pure platform SQL plus the platform's own safe writes, burns
// zero model tokens, and its ledger is the rows it creates plus the run's
// audit. The plan approval covers it: the approver saw the step and its
// target count at approval time, and execution re-derives eligibility so a
// stale approval quietly shrinks rather than acts on dead evidence.
//
// First kind: `draft_recurring` — the month-end checklist's unbilled_income
// detections made actionable. The miner (recurring-suggest.ts, shared with
// the suggestions card and the checklist) finds buyers billed on a monthly
// rhythm with nothing raised this cycle; this step raises the missing
// paper as DRAFTS — the platform's one established safe write (Clerk never
// files; a draft is reviewed before submission). Three properties to keep:
//  - template-covered buyers never appear (the miner excludes buyers a
//    recurring_invoice_template already serves — that sweep owns them);
//  - a created draft joins the mined history, so the pattern stops
//    alerting: the step is naturally idempotent across runs;
//  - amounts are NOT guessed — lines are copied from the buyer's newest
//    invoice in the pattern, and the invoice number is a PLACEHOLDER the
//    client replaces at review (their numbering scheme is theirs).

export type DeterministicStepKind = "draft_recurring";

export const DETERMINISTIC_STEP_KINDS: ReadonlySet<string> = new Set([
  "draft_recurring",
] satisfies DeterministicStepKind[]);

export function isDeterministicKind(
  kind: string,
): kind is DeterministicStepKind {
  return DETERMINISTIC_STEP_KINDS.has(kind);
}

// Drafting is invoice.write work — every role that can approve a template
// plan (the submit kinds' invoice.submit holders) also carries it, so a
// mixed template never strands an approver on this step.
export function deterministicCapability(
  kind: DeterministicStepKind,
): "invoice.write" {
  switch (kind) {
    case "draft_recurring":
      return "invoice.write";
  }
}

// The alerting buyers for one client RIGHT NOW — the assembly half, run at
// approval time inside the caller's firm-bound context (the
// proposalForKind posture). What the approver sees is what was frozen.
export async function assembleDraftRecurring(
  firmId: string,
  clientPartyId: string,
): Promise<string[]> {
  const byBuyer = await buyerBillingHistories(firmId, clientPartyId);
  const today = lagosDateString();
  const buyers: string[] = [];
  for (const entry of byBuyer.values()) {
    if (unbilledAlertFor(entry.invoices, today)) {
      buyers.push(entry.buyerPartyId);
    }
  }
  return buyers;
}

export interface DraftRecurringResult {
  draftIds: string[];
  created: number;
  // Approved buyers whose pattern no longer alerts (an invoice or draft
  // appeared since approval) or could not be drafted — skipped honestly.
  skipped: number;
}

// The execution half, called by the plan-run processor with no ambient
// context: every read and write runs firm-bound (never the raw pool), and
// each draft commits in its own short context — a failure on buyer N
// leaves buyers 1..N-1 created and counted.
export async function executeDraftRecurring(
  firmId: string,
  clientPartyId: string,
  approvedBuyerIds: string[],
  actorId: string,
): Promise<DraftRecurringResult> {
  const today = lagosDateString();
  // Re-mine inside a firm-bound context: only approved buyers whose
  // pattern STILL alerts get paper — approval is not a license to draft
  // against a book that moved.
  const byBuyer = await runRequestContext({ bypass: false, firmId }, () =>
    buyerBillingHistories(firmId, clientPartyId),
  );
  const approved = new Set(approvedBuyerIds);
  const due: Array<{
    buyerPartyId: string;
    currency: string;
    lastInvoiceId: string;
  }> = [];
  for (const entry of byBuyer.values()) {
    if (!approved.has(entry.buyerPartyId)) continue;
    if (!unbilledAlertFor(entry.invoices, today)) continue;
    const last = entry.invoices[entry.invoices.length - 1];
    if (!last) continue;
    due.push({
      buyerPartyId: entry.buyerPartyId,
      currency: entry.currency,
      lastInvoiceId: last.id,
    });
  }

  const result: DraftRecurringResult = {
    draftIds: [],
    created: 0,
    skipped: approvedBuyerIds.length - due.length,
  };
  if (due.length === 0) return result;

  // Seed lines from each pattern's newest invoice — what the client
  // actually bills, never an invented amount (the suggestions card's rule).
  const lineRows = await runRequestContext({ bypass: false, firmId }, () =>
    getDb()
      .select({
        invoiceId: invoiceLinesTable.invoiceId,
        description: invoiceLinesTable.description,
        quantity: invoiceLinesTable.quantity,
        unitPrice: invoiceLinesTable.unitPrice,
        vatRate: invoiceLinesTable.vatRate,
      })
      .from(invoiceLinesTable)
      .where(
        inArray(
          invoiceLinesTable.invoiceId,
          due.map((d) => d.lastInvoiceId),
        ),
      )
      .orderBy(asc(invoiceLinesTable.lineNo)),
  );
  const linesByInvoice = new Map<string, LineInput[]>();
  for (const l of lineRows) {
    const list = linesByInvoice.get(l.invoiceId) ?? [];
    list.push({
      description: l.description,
      quantity: String(Number(l.quantity)),
      unitPrice: String(Number(l.unitPrice)),
      vatRate: String(Number(l.vatRate)),
    });
    linesByInvoice.set(l.invoiceId, list);
  }

  let seq = 0;
  for (const d of due) {
    const lines = linesByInvoice.get(d.lastInvoiceId);
    if (!lines || lines.length === 0) {
      result.skipped += 1;
      continue;
    }
    seq += 1;
    try {
      const { invoice } = await runRequestContext(
        { bypass: false, firmId },
        () =>
          createDraft(
            {
              firmId,
              supplierPartyId: clientPartyId,
              buyerPartyId: d.buyerPartyId,
              // A placeholder the client replaces at review — guessing at
              // their own numbering scheme would collide with it. The DRAFT
              // prefix keeps it visibly unfinished.
              invoiceNumber: `DRAFT-${today.replace(/-/g, "")}-${seq}`,
              // Foreign-currency patterns draft in their own currency with
              // NO rate — the reviewer captures today's rate at review,
              // where a stale mined one would just be silently wrong.
              ...(d.currency !== "NGN" ? { currency: d.currency } : {}),
              issueDate: today,
              dueDate: null,
              lines,
            },
            actorId,
          ),
      );
      result.draftIds.push(invoice.id);
      result.created += 1;
    } catch (err) {
      // One buyer's bad seed (e.g. lines that stopped validating) must not
      // sink the rest — count it skipped and keep drafting.
      logger.warn(
        { err, firmId, buyerPartyId: d.buyerPartyId },
        "draft_recurring: draft failed for buyer",
      );
      result.skipped += 1;
    }
  }
  return result;
}
