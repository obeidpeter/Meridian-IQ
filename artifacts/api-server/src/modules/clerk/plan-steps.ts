import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, like } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  invoicesTable,
  invoiceLinesTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { lagosDateString } from "../../lib/lagos-time";
import { buyerBillingHistories } from "../invoice/recurring-suggest";
import { unbilledAlertFor } from "../invoice/unbilled-income";
import { createDraft } from "../invoice/service";
import type { LineInput } from "../invoice/lines";
import { logger } from "../../lib/logger";

// Close with Clerk Phase 1 (round 34): DETERMINISTIC plan-step kinds — the
// second step class beside the action catalogue. An action step drives
// executeAction and writes a decision-ledger row per batch; a deterministic
// step is pure platform SQL plus the platform's own safe writes, burns
// zero model tokens, and its ledger is the rows it creates (each one
// audited against the run) plus the run's own audits. The plan approval
// covers it: the approver saw the step and its target count at approval
// time, and execution re-derives eligibility so a stale approval quietly
// shrinks rather than acts on dead evidence.
//
// First kind: `draft_recurring` — the month-end checklist's unbilled_income
// detections made actionable. The miner (recurring-suggest.ts, shared with
// the suggestions card and the checklist) finds buyers billed on a monthly
// rhythm with nothing raised this cycle; this step raises the missing
// paper as DRAFTS — the platform's one established safe write (Clerk never
// files; a draft is reviewed before submission). Properties to keep:
//  - template-covered buyers never appear (the miner excludes buyers a
//    recurring_invoice_template already serves — that sweep owns them);
//  - a created draft joins the mined history, so the pattern stops
//    alerting — and an already-open machine draft blocks a second one
//    (the anti-pile-up guard below): the step never nags a neglected
//    client with a growing stack of drafts;
//  - amounts are NOT guessed — lines are copied from the buyer's newest
//    invoice in the pattern, and the invoice number is a PLACEHOLDER the
//    client replaces at review (their numbering scheme is theirs);
//  - the placeholder prefix is ALSO the submission wall (round-34 review
//    BLOCKER): actions.ts overdueCond excludes `DRAFT-%` numbers, so a
//    machine draft can never ride submit_overdue — through the card, a
//    whole-plan approval, or a recurring policy's next month — until a
//    human reviews it and gives it a real number.

export type DeterministicStepKind = "draft_recurring";

export const DETERMINISTIC_STEP_KINDS: ReadonlySet<string> = new Set([
  "draft_recurring",
] satisfies DeterministicStepKind[]);

// The provenance marker on machine-raised drafts. actions.ts overdueCond
// pins the same literal in SQL ("DRAFT-%") — plan-steps.test.ts holds the
// two in lockstep.
export const MACHINE_DRAFT_PREFIX = "DRAFT-";

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

// A step target is a (buyer, currency) PAIR — the miner's own grouping
// (round-34 review M3): a buyer billed in two currencies is two patterns,
// and approving one must not license drafting the other.
export function stepTargetKey(buyerPartyId: string, currency: string): string {
  return `${buyerPartyId}:${currency}`;
}

// (buyer, currency) groups that already carry an OPEN machine draft: the
// missing paper was raised and a human has not dealt with it — raising
// another would stack drafts monthly on a neglected book.
async function openMachineDraftKeys(
  firmId: string,
  clientPartyId: string,
): Promise<Set<string>> {
  const rows = await getDb()
    .select({
      buyerPartyId: invoicesTable.buyerPartyId,
      currency: invoicesTable.currency,
    })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        eq(invoicesTable.supplierPartyId, clientPartyId),
        eq(invoicesTable.status, "draft"),
        like(invoicesTable.invoiceNumber, `${MACHINE_DRAFT_PREFIX}%`),
      ),
    );
  return new Set(rows.map((r) => stepTargetKey(r.buyerPartyId, r.currency)));
}

// The alerting (buyer, currency) pairs for one client RIGHT NOW — the
// assembly half, run at approval time inside the caller's firm-bound
// context (the proposalForKind posture). What the approver sees is what
// was frozen.
export async function assembleDraftRecurring(
  firmId: string,
  clientPartyId: string,
): Promise<string[]> {
  const byBuyer = await buyerBillingHistories(firmId, clientPartyId);
  const blocked = await openMachineDraftKeys(firmId, clientPartyId);
  const today = lagosDateString();
  const targets: string[] = [];
  for (const entry of byBuyer.values()) {
    const key = stepTargetKey(entry.buyerPartyId, entry.currency);
    if (blocked.has(key)) continue;
    if (unbilledAlertFor(entry.invoices, today)) targets.push(key);
  }
  return targets;
}

export interface DraftRecurringResult {
  draftIds: string[];
  created: number;
  // Approved pairs whose pattern no longer alerts, or that already carry
  // an open machine draft — skipped honestly.
  skipped: number;
  // Approved, still-alerting pairs whose draft could not be created (a
  // seed that stopped validating) — REAL failures, fed to the run's
  // half-rule so a fully-failing step halts the plan.
  failed: number;
}

// The execution half, called by the plan-run processor with no ambient
// context: every read and write runs firm-bound (never the raw pool), and
// each draft commits in its own short context — a failure on buyer N
// leaves buyers 1..N-1 created and counted.
export async function executeDraftRecurring(
  firmId: string,
  clientPartyId: string,
  approvedTargets: string[],
  actorId: string,
  planRunId: string,
): Promise<DraftRecurringResult> {
  const today = lagosDateString();
  // Re-mine inside a firm-bound context: only approved pairs whose
  // pattern STILL alerts (and is not already covered by an open machine
  // draft) get paper — approval is not a license to draft against a book
  // that moved.
  const { byBuyer, blocked } = await runRequestContext(
    { bypass: false, firmId },
    async () => ({
      byBuyer: await buyerBillingHistories(firmId, clientPartyId),
      blocked: await openMachineDraftKeys(firmId, clientPartyId),
    }),
  );
  const approved = new Set(approvedTargets);
  const due: Array<{
    buyerPartyId: string;
    currency: string;
    lastInvoiceId: string;
  }> = [];
  for (const entry of byBuyer.values()) {
    const key = stepTargetKey(entry.buyerPartyId, entry.currency);
    if (!approved.has(key)) continue;
    if (blocked.has(key)) continue;
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
    skipped: approvedTargets.length - due.length,
    failed: 0,
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

  for (const d of due) {
    const lines = linesByInvoice.get(d.lastInvoiceId);
    if (!lines || lines.length === 0) {
      result.failed += 1;
      continue;
    }
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
              // their own numbering scheme would collide with it, and the
              // prefix is the submission wall (see the header). Entropy in
              // the suffix (round-34 review m5): a per-batch counter would
              // collide across clients drafted the same day, and a
              // fence-loss re-run could mint a same-client duplicate.
              invoiceNumber: `${MACHINE_DRAFT_PREFIX}${today.replace(/-/g, "")}-${randomUUID().slice(0, 8)}`,
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
      // Durable evidence per draft (round-34 review note): the run's steps
      // jsonb is fenced — a reclaim after execution would re-run against a
      // now-quiet pattern and record nothing — so each created draft also
      // lands in the append-only ledger naming its run. Pointer-only.
      await appendAudit({
        actorId,
        firmId,
        action: "clerk.plan_step.drafted",
        entityType: "clerk_plan_run",
        entityId: planRunId,
        after: { kind: "draft_recurring", draftId: invoice.id },
      });
    } catch (err) {
      // One pair's bad seed (e.g. lines that stopped validating) must not
      // sink the rest — but it IS a failure, counted as one so the run's
      // half-rule can halt a step whose drafts are all failing.
      logger.warn(
        { err, firmId, buyerPartyId: d.buyerPartyId },
        "draft_recurring: draft failed for buyer",
      );
      result.failed += 1;
    }
  }
  return result;
}
