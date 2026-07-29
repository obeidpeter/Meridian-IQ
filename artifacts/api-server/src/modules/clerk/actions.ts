import { desc, eq, and, sql } from "drizzle-orm";
import {
  getDb,
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
import { RECEIVABLE_ORIENTATION } from "../invoice/receivables";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
import { bandExposure } from "../invoice/penalty-exposure";
import { lagosDateString, lagosTodaySql } from "../../lib/lagos-time";

// Proposed actions (round 21 — the advice→assisted-action arc's
// foundation). Every Clerk surface so far ends with "…you should submit
// these" and the human goes clicking one invoice at a time. This module
// closes that gap WITHOUT crossing the platform's one hard line — Clerk
// still never files anything:
//
//  - The action CATALOGUE is closed and code-defined. v1 carries exactly
//    one action, submit_overdue: the safest (submission is the statutory
//    obligation itself), highest-value (it clears s.104 exposure), and
//    fully re-checkable at execution time.
//  - PROPOSALS are computed live from the same detector predicates the
//    digest and penalty card use — never stored, so never stale, and no
//    model call anywhere (deterministic assembly; the model's only role
//    on this surface is nothing at all).
//  - A human APPROVES an explicit target list — the exact invoices the
//    card showed. Approval EXECUTES through the platform's existing
//    per-invoice machinery (validateInvoice's compare-and-set,
//    submitInvoice's exactly-once outbox enqueue, the consent gate, the
//    maker-checker assertSubmitApproved) — the bulk-submit discipline:
//    the batch adds nothing but iteration.
//  - Every target is RE-VALIDATED against the action's predicate at
//    execution: an invoice someone already submitted, cancelled, or that
//    aged out of the proposal is SKIPPED, never double-processed.
//  - The DECISION is the durable artifact: who approved, on what
//    evidence, over which targets, with per-target outcomes
//    (clerk_action_decisions, firm-keyed RLS 0028) plus a pointer-only
//    audit event.
//
// Rollout is fail-closed behind the opt-in `clerk_actions` flag: dark
// means proposals answer empty (the card hides) and execution refuses.

export const ACTIONS_FLAG_KEY = "clerk_actions";

// One proposal shows at most this many targets, and one approval executes
// at most this many — a bounded request (SEC-M3), repeated until done.
export const MAX_ACTION_TARGETS = 50;

export interface ActionTarget {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  daysOverdue: number;
  grandTotal: string | null;
  currency: string;
}

export interface ActionProposal {
  kind: "submit_overdue";
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

// The submit_overdue predicate — the digest/penalty-card overdue spelling,
// verbatim: receivable paper, still draft/validated, past Lagos midnight
// starting day issue+window.
function overdueCond(firmId: string, clientPartyId: string) {
  return sql`i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND i.supplier_party_id = ${clientPartyId}
    AND i.status IN ('draft', 'validated')
    AND ${RECEIVABLE_ORIENTATION}
    AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${lagosTodaySql()}`;
}

export async function listActionProposals(
  firmId: string,
  clientPartyId: string,
): Promise<ActionProposals> {
  const note =
    "Clerk assembles these batches from the same checks that power the dashboards — nothing runs until you approve, " +
    "approval executes through the ordinary submission path (validation, consent, any approval policy), and every target is re-checked at that moment. " +
    "The decision and per-invoice outcomes are recorded.";
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
    return { actions: [], note };
  }

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
        (${lagosTodaySql()} - (i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int))::int AS days_overdue,
        i.grand_total::text AS grand_total, i.currency,
        COUNT(*) OVER ()::int AS full_count
      FROM invoices i
      WHERE ${overdueCond(firmId, clientPartyId)}
      ORDER BY i.issue_date ASC, i.id
      LIMIT ${MAX_ACTION_TARGETS}
    `)
  ).rows;
  if (rows.length === 0) return { actions: [], note };

  const targetCount = Number(rows[0].full_count);
  const targets: ActionTarget[] = rows.map((r) => ({
    invoiceId: r.id,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    daysOverdue: Math.max(Number(r.days_overdue), 0),
    grandTotal: r.grand_total,
    currency: r.currency,
  }));
  const floor = bandExposure(targetCount).small;
  return {
    actions: [
      {
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
      },
    ],
    note,
  };
}

export interface ActionExecution {
  decision: ClerkActionDecision;
}

// Approve-and-execute one batch. The caller's route owns authz
// (invoice.submit + the client scope wall); this function owns the flag,
// the consent gate, per-target re-validation and the decision record.
export async function executeAction(
  firmId: string,
  clientPartyId: string,
  actorId: string,
  kind: string,
  invoiceIds: string[],
): Promise<ActionExecution> {
  if (!(await isFeatureEnabled(ACTIONS_FLAG_KEY, firmId))) {
    throw new DomainError(
      "ACTIONS_DISABLED",
      "Proposed actions are not enabled for this firm",
      503,
    );
  }
  if (kind !== "submit_overdue") {
    throw new DomainError(
      "UNKNOWN_ACTION",
      "That action is not in the catalogue",
      400,
    );
  }
  if (invoiceIds.length === 0 || invoiceIds.length > MAX_ACTION_TARGETS) {
    throw new DomainError(
      "BAD_TARGETS",
      `An action batch names between 1 and ${MAX_ACTION_TARGETS} invoices`,
      400,
    );
  }
  // Dedupe (a repeated id would record two contradictory outcomes for one
  // invoice) and SORT: the caller controls the array order, and processing
  // two concurrent batches over overlapping sets in different orders is a
  // classic crossed-lock deadlock — a canonical order removes that variant.
  const ids = [...new Set(invoiceIds)].sort();
  // Consent gates every submission identically — checked once up front,
  // exactly like a single submit would refuse (CORE-03).
  if (!(await isPurposePermitted(clientPartyId, "compliance_submission"))) {
    throw new DomainError(
      "CONSENT_REQUIRED",
      "Supplier has not granted compliance (layer 1) consent",
      403,
    );
  }

  // The batch audit's one annotation (bulk-submit's shape): an approval
  // policy surfaces per row as APPROVAL_REQUIRED failures, and the hoisted
  // read makes an all-failed batch explicable at a glance.
  const submitApprovalRequired = await firmSubmitApprovalRequired(firmId);

  // Load ONLY the requested ids that are in scope, and re-check the
  // action predicate per row RIGHT NOW: the approval was given on a
  // snapshot, and anything that changed since (submitted elsewhere,
  // cancelled, no longer overdue) must be skipped, never re-processed.
  const candidates = (
    await getDb().execute<{
      id: string;
      invoice_number: string;
      status: string;
      eligible: boolean;
    }>(sql`
      SELECT i.id, i.invoice_number, i.status,
        (${overdueCond(firmId, clientPartyId)}) AS eligible
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND i.id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})
    `)
  ).rows;
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // The evidence a reader of the decision needs — the client's live overdue
  // count and the penalty floor it implies — captured NOW, before the batch
  // runs (verification-pass F4: counting after the loop would record the
  // residual, making a fully-successful approval look baseless).
  const [overdueNow] = (
    await getDb().execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM invoices i
      WHERE ${overdueCond(firmId, clientPartyId)}
    `)
  ).rows;
  const overdueCountAtDecision = Number(overdueNow?.n ?? 0);

  const targets: ActionTargetOutcome[] = [];
  for (const invoiceId of ids) {
    const candidate = byId.get(invoiceId);
    if (!candidate || !candidate.eligible) {
      targets.push({
        invoiceId,
        invoiceNumber: candidate?.invoice_number ?? "(not found)",
        outcome: "skipped_not_eligible",
        error: candidate
          ? "No longer matches the action (already submitted, cancelled, or aged out)"
          : "Not found in this client's records",
      });
      continue;
    }
    // The bulk-submit loop body: the EXISTING per-invoice machinery, so
    // every invoice gets the same lifecycle events, audit rows,
    // maker-checker enforcement and idempotency as a single submit.
    try {
      if (candidate.status === "draft") {
        const validation = await validateInvoice(invoiceId, actorId);
        if (!validation.ok) {
          targets.push({
            invoiceId,
            invoiceNumber: candidate.invoice_number,
            outcome: "invalid",
            error: `${validation.errors.length} validation issue(s) — open the invoice to fix them`,
          });
          continue;
        }
      }
      await submitInvoice(invoiceId, actorId);
      targets.push({
        invoiceId,
        invoiceNumber: candidate.invoice_number,
        outcome: "submitted",
        error: null,
      });
    } catch (err) {
      targets.push({
        invoiceId,
        invoiceNumber: candidate.invoice_number,
        outcome: "failed",
        error:
          err instanceof DomainError
            ? err.message
            : "Submission failed unexpectedly",
      });
    }
  }

  const executedCount = targets.filter((t) => t.outcome === "submitted").length;
  const skippedCount = targets.filter(
    (t) => t.outcome === "skipped_not_eligible",
  ).length;
  const failedCount = targets.filter(
    (t) => t.outcome === "failed" || t.outcome === "invalid",
  ).length;

  const [decision] = await getDb()
    .insert(clerkActionDecisionsTable)
    .values({
      firmId,
      clientPartyId,
      kind,
      decidedBy: actorId,
      evidence: {
        requestedCount: ids.length,
        overdueCountAtDecision,
        exposureFloorNgn: bandExposure(overdueCountAtDecision).small,
        asOf: lagosDateString(new Date()),
      },
      targets,
      requestedCount: ids.length,
      executedCount,
      skippedCount,
      failedCount,
    })
    .returning();

  // Pointer-only audit (SEC-12): counts and the decision id — the
  // per-invoice detail lives on the decision row and each invoice's own
  // lifecycle events.
  await appendAudit({
    actorId,
    firmId,
    action: "clerk.action.executed",
    entityType: "clerk_action_decision",
    entityId: decision.id,
    after: {
      kind,
      requestedCount: ids.length,
      executedCount,
      skippedCount,
      failedCount,
      submitApprovalRequired,
    },
  });

  return { decision };
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
