import { desc, eq, and, sql } from "drizzle-orm";
import {
  getDb,
  runRequestContext,
  clerkActionDecisionsTable,
  type ActionTargetOutcome,
  type ClerkActionDecision,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { isPurposePermitted } from "../consent/consent";
import { validateInvoice, submitInvoice } from "../invoice/service";
import { firmSubmitApprovalRequired } from "../invoice/approvals";
import { OUTSTANDING, RECEIVABLE_ORIENTATION } from "../invoice/receivables";
import {
  SUBMISSION_WINDOW_DAYS,
  UNSUBMITTED_STATE,
  daysPastDeadline,
  pastSubmissionDeadline,
} from "../invoice/compliance-window";
import { bandExposure } from "../invoice/penalty-exposure";
import { listChaseRows } from "../invoice/cashflow";
import {
  phrasePaymentChaser,
  stagePaymentChaser,
  type PaymentChaserDraft,
} from "./draft-chaser";
import { gatewayOrNull } from "./provider";
import type { Principal } from "../auth/rbac";
import { lagosDateString, lagosTodaySql } from "../../lib/lagos-time";

// Proposed actions (rounds 21-22 — the advice→assisted-action arc). Every
// Clerk surface ends with "…you should submit these" and the human goes
// clicking one invoice at a time. This module closes that gap WITHOUT
// crossing the platform's one hard line — Clerk still never files anything:
//
//  - The action CATALOGUE is closed and code-defined. Three actions:
//    submit_overdue (round 21 — the statutory obligation itself),
//    retry_failed (round 22 — resubmission of rail-rejected paper once the
//    cause is fixed), and draft_chasers (round 22 — one approval drafts a
//    staged payment reminder for every chase-worthy receivable; the CLIENT
//    still sends them — the platform sends nothing, exactly the chaser
//    surface's standing posture).
//  - PROPOSALS are computed live from the same detector predicates the
//    digest, penalty card and chase list use — never stored, so never
//    stale, and no model call anywhere in assembly.
//  - A human APPROVES an explicit target list. Approval EXECUTES through
//    the platform's existing per-invoice machinery (validateInvoice's
//    compare-and-set, submitInvoice's exactly-once outbox + per-row
//    maker-checker, draftPaymentChaser's ladder) — the bulk-submit
//    discipline: the batch adds nothing but iteration.
//  - Every target is RE-VALIDATED against its action's predicate at
//    execution; anything that changed since the proposal is SKIPPED.
//  - The DECISION is the durable artifact (clerk_action_decisions,
//    firm-keyed RLS 0028) plus a pointer-only audit event. Chaser draft
//    TEXT rides only the response — the decision row and the audit carry
//    ids/counts, never subject or body (SEC-12; the client owns what is
//    sent). Honesty note (round-22 review M1): a MODEL-phrased draft's
//    output is retained in the firm-scoped inference ledger like every
//    Clerk call — the platform never claims otherwise; template drafts
//    involve no model call and genuinely live nowhere.
//
// Transaction shape (round 22): the execute route runs OUTSIDE the request
// transaction (app.ts NO_CONTEXT_ROUTES) and every stage below commits in
// its own short runRequestContext transaction bound to the CALLER's firm —
// the bulk-approve posture. The honest crash window that buys: a crash
// after per-target commits but before stage Z leaves REAL submits/drafts
// with no decision row and no batch audit — each invoice's own lifecycle
// events and audits still exist, but the batch-level record does not. Two reasons, both hard: a chaser batch makes up
// to MAX_CHASER_TARGETS sequential model calls (far past the 30s
// request-transaction cap), and a submit batch inside one transaction held
// the GLOBAL audit advisory lock from its first appendAudit to the final
// commit — a platform-wide convoy plus a real deadlock window (the round-21
// review's F2 follow-up, closed here). The trade is bulk-approve's: an
// executed target is durable IMMEDIATELY — nothing later in the batch (or a
// response failure) can undo it — and the decision row records what
// actually happened.
//
// Rollout is fail-closed behind the opt-in `clerk_actions` flag (per-firm
// override capable): dark means proposals answer empty (the cards hide) and
// execution refuses.

export const ACTIONS_FLAG_KEY = "clerk_actions";

export type ActionKind = "submit_overdue" | "retry_failed" | "draft_chasers";

// One proposal shows at most this many targets, and one approval executes
// at most this many — a bounded request (SEC-M3), repeated until done.
export const MAX_ACTION_TARGETS = 50;
// A chaser batch is a batch of MODEL calls — bounded much lower; the chase
// list is ranked, so the cap keeps the worst-first ten.
export const MAX_CHASER_TARGETS = 10;
// Round 30 (rail-rejection tripwire, mechanism 1): how many total
// submission_attempts an invoice may accumulate before the AUTOPILOT stops
// offering it back to the rails. submitInvoice returns at ENQUEUE time and a
// rail rejection lands asynchronously (invoice back to 'failed'), so without
// this cap a standing retry_failed approval re-enqueues permanently-rejected
// paper every Lagos day forever. The attempts ledger is append-only, so the
// count only grows — a capped invoice stays out of AUTOMATED assembly for
// good until a human intervenes (fixes and submits, or cancels).
export const AUTO_RETRY_ATTEMPT_CAP = 5;

// Assembly options for the POLICY path only (round 30): the standing-approval
// sweep threads maxSubmissionAttempts through proposalForKind so the
// AUTOMATED candidate SQL drops rail-hammered invoices. The human proposal
// surface (listActionProposals) never sets it — a person still sees, and may
// deliberately re-choose, a target the autopilot has given up on. The human
// proposal SHAPE is unchanged by design.
export interface AssemblyOptions {
  maxSubmissionAttempts?: number;
}

function maxTargetsFor(kind: ActionKind): number {
  return kind === "draft_chasers" ? MAX_CHASER_TARGETS : MAX_ACTION_TARGETS;
}

export interface ActionTarget {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  daysOverdue: number;
  grandTotal: string | null;
  currency: string;
  // Per-kind context line: the last rail error for retry_failed, the buyer
  // and expected date for draft_chasers, null for submit_overdue.
  note: string | null;
}

export interface ActionProposal {
  kind: ActionKind;
  title: string;
  why: string;
  targets: ActionTarget[];
  targetCount: number; // TRUE count — targets is capped
  truncated: boolean;
  evidence: Record<string, string | number>;
}

export interface ActionProposals {
  actions: ActionProposal[];
  note: string;
}

// ---------------------------------------------------------------------------
// Do with Clerk (round 31): the planner-facing index of this catalogue. Ask's
// plan schema offers these keys (per asker capability) exactly like the
// data.* keys, and an act.* step in an answered plan resolves to a live
// proposalForKind() assembly rendered as an approvable section. The model
// only ever SEQUENCES: nothing in an answer executes — approval drives the
// existing execute route, which re-checks capability, flag, consent and
// every target at that moment. Titles are model-facing trusted platform
// text AND the section title the plan line displays.
// ---------------------------------------------------------------------------

export interface ActionIntent {
  key: string;
  kind: ActionKind;
  title: string;
  // The capability the EXISTING execute route demands for this kind — the
  // offer is gated on it so Ask never proposes work the asker could not
  // approve (the route re-asserts it at execution regardless).
  capability: "invoice.submit" | "clerk.capture";
}

export const ACTION_INTENTS: readonly ActionIntent[] = [
  {
    key: "act.submit_overdue",
    kind: "submit_overdue",
    title:
      "assemble this client's overdue unsubmitted invoices into a submission batch the asker approves before anything runs",
    capability: "invoice.submit",
  },
  {
    key: "act.retry_failed",
    kind: "retry_failed",
    title:
      "assemble this client's failed rail submissions into a retry batch the asker approves before anything runs",
    capability: "invoice.submit",
  },
  {
    key: "act.draft_chasers",
    kind: "draft_chasers",
    title:
      "assemble this client's most chase-worthy receivables into a payment-reminder drafting batch the asker approves before anything runs",
    capability: "clerk.capture",
  },
];

// The submit_overdue predicate — the SHARED overdue pieces (the digest,
// penalty card and scorecard compose the same compliance-window fragments):
// receivable paper, still draft/validated, past Lagos midnight starting day
// issue+window. Machine-raised placeholder drafts (the DRAFT-… numbers a
// draft_recurring plan step mints — plan-steps.ts MACHINE_DRAFT_PREFIX) are
// EXCLUDED (round-34 review BLOCKER): this predicate is both the proposal
// assembly and executeAction's per-target re-validation, so without the
// wall a recurring month-end policy would draft in month M and auto-submit
// the unreviewed placeholder through the rails in month M+1 — fabricated
// statutory paper no human ever looked at. A human review naturally clears
// the wall: replacing the placeholder with the client's real number (which
// review requires anyway) makes the draft ordinary overdue paper. The
// month-end checklist still COUNTS these drafts as overdue attention items
// (the penalty predicate carries no such wall) — the standing nag that
// sends a human to review them.
function overdueCond(firmId: string, clientPartyId: string) {
  return sql`i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND i.supplier_party_id = ${clientPartyId}
    AND i.invoice_number NOT LIKE 'DRAFT-%'
    AND ${UNSUBMITTED_STATE}
    AND ${RECEIVABLE_ORIENTATION}
    AND ${pastSubmissionDeadline(lagosTodaySql())}`;
}

// The retry_failed predicate: receivable paper the rails rejected. The
// lifecycle allows failed → submitted directly (fix-and-retry), so the
// executor is submitInvoice itself.
function failedCond(firmId: string, clientPartyId: string) {
  return sql`i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND i.supplier_party_id = ${clientPartyId}
    AND i.status = 'failed'
    AND ${RECEIVABLE_ORIENTATION}`;
}

// The draft_chasers eligibility core: an outstanding receivable of this
// client (the chase list ranks WITHIN this set; draftPaymentChaser re-checks
// it again per invoice).
function chaseableCond(firmId: string, clientPartyId: string) {
  return sql`i.firm_id = ${firmId}
    AND i.supplier_party_id = ${clientPartyId}
    AND ${OUTSTANDING}
    AND ${RECEIVABLE_ORIENTATION}`;
}

async function submitOverdueProposal(
  firmId: string,
  clientPartyId: string,
): Promise<ActionProposal | null> {
  const rows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      issue_date: string;
      days_overdue: number;
      grand_total: string | null;
      currency: string;
      full_count: number;
    }>(sql`
      SELECT i.id, i.invoice_number, i.issue_date::text AS issue_date,
        ${daysPastDeadline(lagosTodaySql())} AS days_overdue,
        i.grand_total::text AS grand_total, i.currency,
        COUNT(*) OVER ()::int AS full_count
      FROM invoices i
      WHERE ${overdueCond(firmId, clientPartyId)}
      ORDER BY i.issue_date ASC, i.id
      LIMIT ${MAX_ACTION_TARGETS}
    `)
  ).rows;
  if (rows.length === 0) return null;

  const targetCount = Number(rows[0].full_count);
  const targets: ActionTarget[] = rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    daysOverdue: Math.max(Number(r.days_overdue), 0),
    grandTotal: r.grand_total,
    currency: r.currency,
    note: null,
  }));
  const floor = bandExposure(targetCount).small;
  return {
    kind: "submit_overdue",
    title: `Submit ${targetCount} overdue invoice${targetCount === 1 ? "" : "s"}`,
    why:
      `${targetCount} invoice${targetCount === 1 ? " is" : "s are"} past the ${SUBMISSION_WINDOW_DAYS}-day statutory submission window — ` +
      `at least NGN ${floor} of estimated s.104 exposure (lowest band, an estimate not advice). Submitting them removes it` +
      // The floor spans the FULL overdue count; a capped batch only
      // clears its own share, so say so.
      (targetCount > MAX_ACTION_TARGETS
        ? ` — approve in batches of up to ${MAX_ACTION_TARGETS}.`
        : "."),
    targets,
    targetCount,
    truncated: targetCount > targets.length,
    evidence: {
      overdueCount: targetCount,
      exposureFloorNgn: floor,
      asOf: lagosDateString(new Date()),
    },
  };
}

async function retryFailedProposal(
  firmId: string,
  clientPartyId: string,
  opts?: AssemblyOptions,
): Promise<ActionProposal | null> {
  // The policy-path attempt cap (round 30): counts the FULL append-only
  // attempts ledger — every enqueue the rails already bounced — so a capped
  // invoice drops out of the automated candidate set (and its full_count)
  // entirely. Absent the option (every human surface), the predicate is
  // byte-identical to the historical one.
  const attemptCapCond =
    opts?.maxSubmissionAttempts === undefined
      ? sql``
      : sql`AND (SELECT COUNT(*) FROM submission_attempts ac
          WHERE ac.invoice_id = i.id) < ${opts.maxSubmissionAttempts}`;
  const rows = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      issue_date: string;
      days_overdue: number;
      grand_total: string | null;
      currency: string;
      error_code: string | null;
      full_count: number;
    }>(sql`
      SELECT i.id, i.invoice_number, i.issue_date::text AS issue_date,
        GREATEST(${daysPastDeadline(lagosTodaySql())}, 0) AS days_overdue,
        i.grand_total::text AS grand_total, i.currency,
        (SELECT a.error_code FROM submission_attempts a
          WHERE a.invoice_id = i.id AND a.error_code IS NOT NULL
          ORDER BY a.created_at DESC LIMIT 1) AS error_code,
        COUNT(*) OVER ()::int AS full_count
      FROM invoices i
      WHERE ${failedCond(firmId, clientPartyId)}
        ${attemptCapCond}
      ORDER BY i.issue_date ASC, i.id
      LIMIT ${MAX_ACTION_TARGETS}
    `)
  ).rows;
  if (rows.length === 0) return null;

  const targetCount = Number(rows[0].full_count);
  return {
    kind: "retry_failed",
    title: `Retry ${targetCount} failed submission${targetCount === 1 ? "" : "s"}`,
    why:
      `${targetCount} submission${targetCount === 1 ? "" : "s"} came back failed from the rails. ` +
      `If the cause has been fixed — a corrected TIN, a rail outage that passed — retrying sends them through the ordinary submission path again. ` +
      `An unchanged invoice with an unfixed cause will simply fail again.`,
    targets: rows.map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      issueDate: r.issue_date,
      daysOverdue: Math.max(Number(r.days_overdue), 0),
      grandTotal: r.grand_total,
      currency: r.currency,
      note: r.error_code ? `last failure: ${r.error_code}` : null,
    })),
    targetCount,
    truncated: targetCount > rows.length,
    evidence: {
      failedCount: targetCount,
      asOf: lagosDateString(new Date()),
    },
  };
}

async function draftChasersProposal(
  firmId: string,
  clientPartyId: string,
): Promise<ActionProposal | null> {
  // The chase list EXACTLY as the dashboard card ranks it — late against
  // each buyer's OWN rhythm, worst first, primary currency.
  const rows = await listChaseRows(firmId, clientPartyId);
  if (rows.length === 0) return null;
  const capped = rows.slice(0, MAX_CHASER_TARGETS);

  // issue_date for the target line (ChaseRow carries the projection dates,
  // not the paper's own) — one bounded lookup over the capped ids.
  const issueDates = new Map(
    (
      await getDb().execute<{ id: string; issue_date: string }>(sql`
        SELECT i.id, i.issue_date::text AS issue_date FROM invoices i
        WHERE i.firm_id = ${firmId} AND i.id IN (${sql.join(
          capped.map((r) => sql`${r.invoiceId}`),
          sql`, `,
        )})
      `)
    ).rows.map((r) => [r.id, r.issue_date]),
  );

  return {
    kind: "draft_chasers",
    title: `Draft ${rows.length} payment reminder${rows.length === 1 ? "" : "s"}`,
    why:
      `${rows.length} receivable${rows.length === 1 ? " is" : "s are"} late against the buyer's own payment rhythm. ` +
      `Approving drafts a staged reminder for each — a first nudge or a follow-up, per its own ladder — for you to review and send yourself. ` +
      `The platform sends nothing.`,
    targets: capped.map((r) => ({
      invoiceId: r.invoiceId,
      invoiceNumber: r.invoiceNumber,
      issueDate: issueDates.get(r.invoiceId) ?? r.expectedDate,
      daysOverdue: Math.max(r.daysBeyondExpected, 0),
      grandTotal: r.grandTotal,
      currency: r.currency,
      note: `${r.buyerName} · expected by ${r.expectedDate}`,
    })),
    targetCount: rows.length,
    truncated: rows.length > capped.length,
    evidence: {
      chaseWorthyCount: rows.length,
      asOf: lagosDateString(new Date()),
    },
  };
}

// Round 28: the standing-approval sweep assembles a policy's batch from the
// SAME live builders the proposal surface uses — one entry point keyed by
// kind, so the autopilot can never select targets the card would not show.
// Round 30 narrows that to "a SUBSET of what the card would show": the
// sweep's opts drop rail-hammered retry candidates (attempt cap) that the
// human proposal keeps offering. Only retry_failed consumes the option —
// submit_overdue targets are UNSUBMITTED paper (a rail rejection moves them
// to 'failed' and out of that predicate on its own), and draft_chasers
// submits nothing.
export function proposalForKind(
  kind: ActionKind,
  firmId: string,
  clientPartyId: string,
  opts?: AssemblyOptions,
): Promise<ActionProposal | null> {
  return kind === "submit_overdue"
    ? submitOverdueProposal(firmId, clientPartyId)
    : kind === "retry_failed"
      ? retryFailedProposal(firmId, clientPartyId, opts)
      : draftChasersProposal(firmId, clientPartyId);
}

export async function listActionProposals(
  firmId: string,
  clientPartyId: string,
): Promise<ActionProposals> {
  const note =
    "Clerk assembles these batches from the same checks that power the dashboards — nothing runs until you approve, " +
    "approval executes through the ordinary per-invoice path (validation, consent, any approval policy), and every target is re-checked at that moment. " +
    "The decision and per-invoice outcomes are recorded.";
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
    return { actions: [], note };
  }

  const proposals = [
    await submitOverdueProposal(firmId, clientPartyId),
    await retryFailedProposal(firmId, clientPartyId),
    await draftChasersProposal(firmId, clientPartyId),
  ];
  return {
    actions: proposals.filter((p): p is ActionProposal => p !== null),
    note,
  };
}

export interface ActionExecution {
  decision: ClerkActionDecision;
  // Chaser batches only: the drafted reminders, shown once for the human
  // to copy and send — no DRAFT is stored anywhere (the chaser posture;
  // model output lands in the inference ledger like every Clerk call).
  drafts: PaymentChaserDraft[] | null;
}

type Candidate = {
  id: string;
  invoice_number: string;
  status: string;
  eligible: boolean;
};

// Approve-and-execute one batch. The caller's route owns authz (the
// capability + the client scope wall + assertPartyAccess); this function
// owns the flag, the consent gate (submit kinds), per-target re-validation
// and the decision record. Runs OUTSIDE any ambient transaction — every
// stage opens its own short firm-bound context (see the header).
export async function executeAction(
  firmId: string,
  clientPartyId: string,
  actorId: string,
  kind: string,
  invoiceIds: string[],
  principal: Principal,
  // Round 28: set by the standing-approval sweep — the decision row and the
  // audit then name the policy that authorized this run (actorId is the
  // GRANTOR, re-validated by the sweep just before this call).
  // planRunId (round 32): set by the plan-run processor — the decision
  // row then names the run whose whole-plan approval authorized it.
  opts?: { policyId?: string; planRunId?: string },
): Promise<ActionExecution> {
  if (
    kind !== "submit_overdue" &&
    kind !== "retry_failed" &&
    kind !== "draft_chasers"
  ) {
    throw new DomainError(
      "UNKNOWN_ACTION",
      "That action is not in the catalogue",
      400,
    );
  }
  const max = maxTargetsFor(kind);
  if (invoiceIds.length === 0 || invoiceIds.length > max) {
    throw new DomainError(
      "BAD_TARGETS",
      `A ${kind} batch names between 1 and ${max} invoices`,
      400,
    );
  }
  // Dedupe (a repeated id would record two contradictory outcomes for one
  // invoice) and SORT: the caller controls the array order, and processing
  // two concurrent batches over overlapping sets in different orders is a
  // classic crossed-lock deadlock — a canonical order removes that variant.
  const ids = [...new Set(invoiceIds)].sort();

  const ctx = <T>(fn: () => Promise<T>): Promise<T> =>
    runRequestContext({ bypass: false, firmId }, fn);

  // Stage A — gates, candidates and pre-execution evidence, one short
  // read-mostly transaction bound to the caller's firm.
  const staged = await ctx(async () => {
    if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
      throw new DomainError(
        "ACTIONS_DISABLED",
        "Proposed actions are not enabled for this firm",
        503,
      );
    }
    // Consent gates every SUBMISSION identically — checked once up front,
    // exactly like a single submit would refuse (CORE-03). Drafting a
    // reminder submits nothing, so the chaser kind carries no consent gate
    // (the single draft-chaser route has none either).
    if (kind !== "draft_chasers") {
      if (!(await isPurposePermitted(clientPartyId, "compliance_submission"))) {
        throw new DomainError(
          "CONSENT_REQUIRED",
          "Supplier has not granted compliance (layer 1) consent",
          403,
        );
      }
    }

    const eligibleCond =
      kind === "submit_overdue"
        ? overdueCond(firmId, clientPartyId)
        : kind === "retry_failed"
          ? failedCond(firmId, clientPartyId)
          : chaseableCond(firmId, clientPartyId);

    // Load ONLY the requested ids that are in scope, and re-check the
    // action predicate per row RIGHT NOW: the approval was given on a
    // snapshot, and anything that changed since (submitted elsewhere,
    // cancelled, settled, no longer overdue) must be skipped, never
    // re-processed.
    const candidates = (
      await getDb().execute<Candidate>(sql`
        SELECT i.id, i.invoice_number, i.status,
          (${eligibleCond}) AS eligible
        FROM invoices i
        WHERE i.firm_id = ${firmId}
          AND i.supplier_party_id = ${clientPartyId}
          AND i.id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})
      `)
    ).rows;

    // The evidence a reader of the decision needs — captured NOW, before
    // the batch runs (counting after would record the residual, making a
    // fully-successful approval look baseless).
    const [countRow] = (
      await getDb().execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM invoices i WHERE ${eligibleCond}
      `)
    ).rows;

    // The batch audit's one annotation (bulk-submit's shape): an approval
    // policy surfaces per row as APPROVAL_REQUIRED failures, and the
    // hoisted read makes an all-failed batch explicable at a glance.
    const approvalRequired =
      kind === "draft_chasers"
        ? null
        : await firmSubmitApprovalRequired(firmId);

    return {
      byId: new Map(candidates.map((c) => [c.id, c])),
      eligibleAtDecision: Number(countRow?.n ?? 0),
      approvalRequired,
    };
  });

  // Chaser batches phrase through the gateway when one is constructible;
  // the deterministic template always answers otherwise (the chaser
  // surface's standing guarantee — a batch never 502s for a model reason).
  const gateway = kind === "draft_chasers" ? await gatewayOrNull() : null;

  const targets: ActionTargetOutcome[] = [];
  const drafts: PaymentChaserDraft[] = [];
  for (const invoiceId of ids) {
    const candidate = staged.byId.get(invoiceId);
    if (!candidate || !candidate.eligible) {
      targets.push({
        invoiceId,
        invoiceNumber: candidate?.invoice_number ?? "(not found)",
        outcome: "skipped_not_eligible",
        error: candidate
          ? "No longer matches the action (already processed, cancelled, or aged out)"
          : "Not found in this client's records",
      });
      continue;
    }
    // Each target runs in its OWN short firm-bound transaction: the
    // existing per-invoice machinery commits per item, the global audit
    // lock is held per item only, and an executed target is durable
    // immediately (bulk-approve semantics). The chaser target's DB half
    // (stagePaymentChaser) commits and releases its connection BEFORE the
    // provider is touched; phrasePaymentChaser then runs transaction-free,
    // its ledger/audit writes landing on the raw pool (the round-22 review
    // M3 split — no pooled connection is ever pinned across model latency).
    try {
      if (kind === "draft_chasers") {
        const staged = await ctx(() =>
          stagePaymentChaser(invoiceId, principal),
        );
        const draft = await phrasePaymentChaser(staged, gateway);
        drafts.push(draft);
        targets.push({
          invoiceId,
          invoiceNumber: candidate.invoice_number,
          outcome: "drafted",
          error: null,
        });
        continue;
      }
      await ctx(async () => {
        if (kind === "submit_overdue" && candidate.status === "draft") {
          const validation = await validateInvoice(invoiceId, actorId);
          if (!validation.ok) {
            throw new DomainError(
              "INVALID_DRAFT",
              `${validation.errors.length} validation issue(s) — open the invoice to fix them`,
              422,
            );
          }
        }
        await submitInvoice(invoiceId, actorId);
      });
      targets.push({
        invoiceId,
        invoiceNumber: candidate.invoice_number,
        outcome: "submitted",
        error: null,
      });
    } catch (err) {
      const invalid =
        err instanceof DomainError && err.code === "INVALID_DRAFT";
      targets.push({
        invoiceId,
        invoiceNumber: candidate.invoice_number,
        outcome: invalid ? "invalid" : "failed",
        error:
          err instanceof DomainError
            ? err.message
            : kind === "draft_chasers"
              ? "Drafting failed unexpectedly"
              : "Submission failed unexpectedly",
      });
    }
  }

  const executedCount = targets.filter(
    (t) => t.outcome === "submitted" || t.outcome === "drafted",
  ).length;
  const skippedCount = targets.filter(
    (t) => t.outcome === "skipped_not_eligible",
  ).length;
  const failedCount = targets.filter(
    (t) => t.outcome === "failed" || t.outcome === "invalid",
  ).length;

  const evidenceCountKey =
    kind === "submit_overdue"
      ? "overdueCountAtDecision"
      : kind === "retry_failed"
        ? "failedCountAtDecision"
        : "chaseableAtDecision";

  // Stage Z — the durable decision + the pointer-only batch audit, one
  // final short transaction.
  const decision = await ctx(async () => {
    const evidence: Record<string, unknown> = {
      requestedCount: ids.length,
      [evidenceCountKey]: staged.eligibleAtDecision,
      asOf: lagosDateString(new Date()),
    };
    if (kind === "submit_overdue") {
      evidence.exposureFloorNgn = bandExposure(staged.eligibleAtDecision).small;
    }
    const [row] = await getDb()
      .insert(clerkActionDecisionsTable)
      .values({
        firmId,
        clientPartyId,
        kind,
        decidedBy: actorId,
        policyId: opts?.policyId ?? null,
        planRunId: opts?.planRunId ?? null,
        evidence,
        targets,
        requestedCount: ids.length,
        executedCount,
        skippedCount,
        failedCount,
      })
      .returning();

    // Pointer-only audit (SEC-12): counts and the decision id — the
    // per-invoice detail lives on the decision row and each invoice's own
    // lifecycle events; no chaser subject/body appears here or on the
    // decision row.
    await appendAudit({
      actorId,
      firmId,
      action: "clerk.action.executed",
      entityType: "clerk_action_decision",
      entityId: row.id,
      after: {
        kind,
        requestedCount: ids.length,
        executedCount,
        skippedCount,
        failedCount,
        submitApprovalRequired: staged.approvalRequired,
        ...(opts?.policyId ? { policyId: opts.policyId } : {}),
        ...(opts?.planRunId ? { planRunId: opts.planRunId } : {}),
      },
    });
    return row;
  });

  return { decision, drafts: kind === "draft_chasers" ? drafts : null };
}

export async function listActionDecisions(
  firmId: string,
  clientPartyId: string,
): Promise<ClerkActionDecision[]> {
  return getDb()
    .select()
    .from(clerkActionDecisionsTable)
    .where(
      and(
        eq(clerkActionDecisionsTable.firmId, firmId),
        eq(clerkActionDecisionsTable.clientPartyId, clientPartyId),
      ),
    )
    .orderBy(
      desc(clerkActionDecisionsTable.createdAt),
      desc(clerkActionDecisionsTable.id),
    )
    .limit(10);
}
