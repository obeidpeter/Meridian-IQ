import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, like, sql } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  bankStatementLinesTable,
  bankStatementsTable,
  invoicesTable,
  invoiceLinesTable,
  matchProposalsTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { lagosDateString } from "../../lib/lagos-time";
import { isFeatureEnabled } from "../flags/flags";
import { buyerBillingHistories } from "../invoice/recurring-suggest";
import { unbilledAlertFor } from "../invoice/unbilled-income";
import { createDraft } from "../invoice/service";
import type { LineInput } from "../invoice/lines";
import { acceptProposal } from "../statements/service";
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

export type DeterministicStepKind = "draft_recurring" | "reconcile_matches";

export const DETERMINISTIC_STEP_KINDS: ReadonlySet<string> = new Set([
  "draft_recurring",
  "reconcile_matches",
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
// mixed template never strands an approver on this step. Accepting matches
// is reconciliation.act, which client_users do NOT hold — that kind is an
// OPTIONAL_PLAN_KINDS member (plan-runs.ts): skipped, never stranding.
export function deterministicCapability(
  kind: DeterministicStepKind,
): "invoice.write" | "reconciliation.act" {
  switch (kind) {
    case "draft_recurring":
      return "invoice.write";
    case "reconcile_matches":
      return "reconciliation.act";
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

// The one result shape every deterministic executor returns (round 35):
// the processor maps executed/skipped/failed onto the step verbatim and
// feeds `failed` to the run's half-rule.
export interface DeterministicStepResult {
  // Pointers to draft invoices the step created (draft_recurring only;
  // empty for kinds that create nothing).
  draftIds: string[];
  executed: number;
  // Approved targets no longer eligible at execution time — skipped
  // honestly, never acted on.
  skipped: number;
  // Approved, still-eligible targets whose write failed — REAL failures,
  // fed to the run's half-rule so a fully-failing step halts the plan.
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
): Promise<DeterministicStepResult> {
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

  const result: DeterministicStepResult = {
    draftIds: [],
    executed: 0,
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
      result.executed += 1;
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

// ---- reconcile_matches (round 35, Close with Clerk Phase 2) ----------------
// The riskiest deterministic kind: accepting a match settles an invoice on
// payment evidence, so it rides its OWN opt-in flag beside clerk_actions
// (dark = the step never assembles), a threshold STRICTER than the
// human-initiated bulk-accept default, and a hard per-run cap. Every
// acceptance goes through the ordinary acceptProposal path — one
// settlement event, one lifecycle transition, one audit row per proposal,
// identical to a manual click — and everything below the threshold stays a
// suggestion for a human.

export const AUTO_RECONCILE_FLAG_KEY = "clerk_auto_reconcile";
// Bulk-accept's human-initiated default is 0.85; the autopilot bar is
// higher — only near-exact matches (amount+reference agreement) clear it.
export const AUTO_RECONCILE_THRESHOLD = 0.9;
export const AUTO_RECONCILE_CAP = 20;

interface ReconcileCandidate {
  id: string;
  statementLineId: string;
  invoiceId: string;
}

// Both flags must be lit (round-35 review m4): the base reconciliation
// flag gates every HUMAN surface — including merely viewing proposals —
// so the autopilot must never keep accepting through pages a rolled-back
// firm cannot even open. clerk_auto_reconcile then layers the autopilot
// opt-in on top (the clerk_action_policies-on-clerk_actions pattern).
async function autoReconcileEnabled(firmId: string): Promise<boolean> {
  return (
    (await isFeatureEnabled("reconciliation", firmId)) &&
    (await isFeatureEnabled(AUTO_RECONCILE_FLAG_KEY, firmId))
  );
}

// Best proposal per statement line AND per invoice at or above the
// autopilot threshold, over the client's committed statements,
// RECEIVABLES ONLY, capped. Confidence-descending so the dedup keeps the
// strongest. The two dedups (round-35 review M1): one line settles one
// invoice (acceptProposal's own supersede rule), and one invoice takes
// one line per run — a duplicated bank credit (retried NIP transfer,
// overlapping uploads) must yield ONE acceptance and leave its twin a
// human suggestion, not manufacture a deterministic INVOICE_NOT_ELIGIBLE
// failure that halts the plan. The orientation join (round-35 review M3):
// the step's mandate is settling RECEIPTS — a bill proposal (the client
// as buyer) would flip a payable's evidence-only payStatus to "paid"
// unattended, suppressing the firm's own chase of a real debt; debit-lane
// matches stay human suggestions.
async function reconcileCandidates(
  firmId: string,
  clientPartyId: string,
  ids?: string[],
): Promise<ReconcileCandidate[]> {
  const rows = await getDb()
    .select({
      id: matchProposalsTable.id,
      statementLineId: matchProposalsTable.statementLineId,
      invoiceId: matchProposalsTable.invoiceId,
    })
    .from(matchProposalsTable)
    .innerJoin(
      bankStatementLinesTable,
      eq(matchProposalsTable.statementLineId, bankStatementLinesTable.id),
    )
    .innerJoin(
      bankStatementsTable,
      eq(bankStatementLinesTable.statementId, bankStatementsTable.id),
    )
    .innerJoin(
      invoicesTable,
      eq(matchProposalsTable.invoiceId, invoicesTable.id),
    )
    .where(
      and(
        eq(matchProposalsTable.firmId, firmId),
        eq(bankStatementsTable.firmId, firmId),
        eq(bankStatementsTable.clientPartyId, clientPartyId),
        // Receivable orientation, the candidate-set precedence rule: the
        // client as SUPPLIER (a self-trade counts as a receivable).
        eq(invoicesTable.supplierPartyId, clientPartyId),
        // A proposal whose invoice already settled (another line's accept,
        // a manual click) or died cannot settle again — freezing it would
        // only manufacture INVOICE_NOT_ELIGIBLE noise at execution.
        sql`${invoicesTable.status} NOT IN ('settled', 'cancelled', 'credited')`,
        eq(matchProposalsTable.status, "proposed"),
        sql`${matchProposalsTable.confidence} >= ${AUTO_RECONCILE_THRESHOLD}`,
        ...(ids && ids.length > 0
          ? [inArray(matchProposalsTable.id, ids)]
          : []),
      ),
    )
    .orderBy(desc(matchProposalsTable.confidence))
    .limit(AUTO_RECONCILE_CAP * 3);
  const seenLines = new Set<string>();
  const seenInvoices = new Set<string>();
  const best: ReconcileCandidate[] = [];
  for (const r of rows) {
    if (seenLines.has(r.statementLineId)) continue;
    if (seenInvoices.has(r.invoiceId)) continue;
    seenLines.add(r.statementLineId);
    seenInvoices.add(r.invoiceId);
    best.push(r);
    if (best.length >= AUTO_RECONCILE_CAP) break;
  }
  return best;
}

// Assembly half: the proposal ids the approver is shown and freezes. An
// unlit flag assembles NOTHING — the step simply never appears in the
// plan, so the rollout switch needs no template change.
export async function assembleReconcileMatches(
  firmId: string,
  clientPartyId: string,
): Promise<string[]> {
  if (!(await autoReconcileEnabled(firmId))) return [];
  return (await reconcileCandidates(firmId, clientPartyId)).map((c) => c.id);
}

// Execution half: re-derive eligibility over the FROZEN ids — still
// proposed, still above the bar, still this client's statement (a manual
// accept supersedes siblings; a rescored or decided proposal drops out) —
// then accept through the ordinary path under the approver's authority.
export async function executeReconcileMatches(
  firmId: string,
  clientPartyId: string,
  approvedIds: string[],
  actor: { userId: string; role: string },
  planRunId: string,
): Promise<DeterministicStepResult> {
  const result: DeterministicStepResult = {
    draftIds: [],
    executed: 0,
    skipped: 0,
    failed: 0,
  };
  if (approvedIds.length === 0) return result;
  // Flag re-check (the dark-flag TOCTOU discipline): a firm that opted out
  // between approval and execution gets NO acceptances — all targets skip.
  if (!(await autoReconcileEnabled(firmId))) {
    result.skipped = approvedIds.length;
    return result;
  }
  const eligible = await runRequestContext({ bypass: false, firmId }, () =>
    reconcileCandidates(firmId, clientPartyId, approvedIds),
  );
  result.skipped = approvedIds.length - eligible.length;
  for (const c of eligible) {
    try {
      const decision = await runRequestContext({ bypass: false, firmId }, () =>
        acceptProposal(c.id, actor, {
          // Defense-in-depth (round-35 review m7): the predicates that
          // justified this id are re-asserted where the write happens.
          expectedClientPartyId: clientPartyId,
          minConfidence: AUTO_RECONCILE_THRESHOLD,
        }),
      );
      result.executed += 1;
      // Durable per-acceptance evidence naming the run (the drafted-audit
      // twin): acceptProposal already audited reconciliation.accept; this
      // row ties it to the plan that did it. Pointer-only.
      await appendAudit({
        actorId: actor.userId,
        firmId,
        action: "clerk.plan_step.reconciled",
        entityType: "clerk_plan_run",
        entityId: planRunId,
        after: {
          kind: "reconcile_matches",
          proposalId: c.id,
          settlementEventId: decision.settlementEventId,
        },
      });
    } catch (err) {
      // The-world-moved DomainErrors are SKIPS, not failures (round-35
      // review M1): a race with a manual accept (PROPOSAL_DECIDED) or an
      // invoice another line just settled (INVOICE_NOT_ELIGIBLE) is the
      // executeAction skipped_not_eligible discipline — it must not feed
      // the half-rule and halt the plan over ordinary book movement.
      if (
        err instanceof DomainError &&
        (err.code === "PROPOSAL_DECIDED" || err.code === "INVOICE_NOT_ELIGIBLE")
      ) {
        result.skipped += 1;
        continue;
      }
      logger.warn(
        { err, firmId, proposalId: c.id },
        "reconcile_matches: accept failed for proposal",
      );
      result.failed += 1;
    }
  }
  return result;
}
