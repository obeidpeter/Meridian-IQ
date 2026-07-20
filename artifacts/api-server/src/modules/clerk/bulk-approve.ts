import { runRequestContext, type ClerkCase } from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { decideCase, getCase, type CaseDecisionInput } from "./cases";

// Fast-lane bulk approval (operator throughput). The console's intake queue
// marks a case "ready to approve" when extraction succeeded, pre-flight found
// nothing blocking and every critical field is confident — this module lets
// an operator approve a page of those in one request while the per-case
// machinery stays EXACTLY what a single decision runs: decideCase's
// compare-and-set on status, its operator-confirmed-values requirement, its
// audit rows and its draft-invoice-only invariant. The batch adds iteration,
// a server-side eligibility re-check per item, and per-row outcomes — one bad
// row never aborts the batch, and nothing here is automatic: the operator
// chose every case and supplied every confirmed value.
//
// Transaction shape: the route runs OUTSIDE the request transaction (app.ts
// NO_CONTEXT_ROUTES) and each item commits in its own short bypass
// transaction below. Inside one request transaction, the first item's
// appendAudit would take the GLOBAL audit advisory xact lock (audit.ts) and
// hold it until the whole 50-item batch committed — a platform-wide
// appendAudit convoy, a 30s-cap risk, and a real deadlock window (approve
// orders audit-lock→row-lock; reject/claim order row-lock→audit-lock).
// Per-item commit matches bulk-submit's semantics: a decided item STAYS
// decided even if a later item (or the response) fails, the audit lock is
// held per item only, and decideCase's alias-memory exhaust (raw pool,
// self-committing) can no longer learn from a batch that later rolls back —
// its item's decision commits an instant after it, and nothing batch-wide
// can undo either.

// Mirrors the console's fast-lane predicate `isReadyToApprove`
// (artifacts/console/src/pages/clerk-shared.ts) — if that predicate changes,
// change this one too, or the queue will offer bulk approval the server then
// refuses (and vice versa). The rules, restated server-side because the
// client is never trusted to enforce them:
//  - status must be exactly "extracted" (unclaimed fast lane — a claimed,
//    escalated or failed case needs a human on the single-case path);
//  - preflight must be a PRESENT array ("never ran" is not the same as
//    "clear") with no non-advisory issue;
//  - every critical extraction field must have a value at high confidence.
export const FAST_LANE_CONFIDENCE = 0.9;

export function fastLaneBlocker(
  kase: Pick<ClerkCase, "status" | "preflight" | "extraction">,
): string | null {
  if (kase.status !== "extracted") {
    return `only fast-lane cases awaiting review can be bulk-approved (status is '${kase.status}')`;
  }
  if (!Array.isArray(kase.preflight)) {
    return "pre-flight has not run for this case";
  }
  const blocking = kase.preflight.find((i) => i.severity !== "advisory");
  if (blocking) {
    return `pre-flight found a blocking issue (${blocking.field}: ${blocking.message})`;
  }
  const weak = (kase.extraction?.fields ?? []).find(
    (f) =>
      f.critical && (f.value == null || f.confidence < FAST_LANE_CONFIDENCE),
  );
  if (weak) {
    return weak.value == null
      ? `critical field '${weak.field}' has no extracted value`
      : `critical field '${weak.field}' is below the fast-lane confidence bar`;
  }
  return null;
}

// Control-flow marker for an item refused BEFORE any decision write: thrown
// inside the per-item transaction (aborting it — it held only reads) and
// caught by the loop to record the skip reason.
class BulkSkip extends Error {}

export interface BulkApproveItem {
  caseId: string;
  decision: CaseDecisionInput;
}

export interface BulkApproveRowResult {
  caseId: string;
  outcome: "approved" | "skipped";
  reason: string | null;
}

export interface BulkApproveResult {
  results: BulkApproveRowResult[];
}

export async function bulkApproveCases(
  items: BulkApproveItem[],
  actorId: string,
): Promise<BulkApproveResult> {
  const results: BulkApproveRowResult[] = [];

  for (const item of items) {
    const skip = (reason: string): void => {
      results.push({ caseId: item.caseId, outcome: "skipped", reason });
    };

    // This endpoint exists for the fast lane only: rejections and
    // escalations carry judgement a batch must not blur.
    if (item.decision.action !== "approve") {
      skip("only approvals may be bulked");
      continue;
    }

    try {
      // Each item runs in its OWN short committed transaction, with the same
      // bypass RLS posture the operator's request transaction would have
      // carried (clerk.use is operator-only; operators are BYPASS_ROLES in
      // app.ts). decideCase creates the draft invoice BEFORE its status
      // compare-and-set, and the single-decision route relies on the 4xx
      // rollback to discard that draft when the CAS loses a race. Here the
      // error is CAUGHT (the batch continues, the response is 200), so the
      // per-item transaction is what rolls the losing item's writes back —
      // without it a decided-elsewhere case would commit an orphaned draft.
      // A committed item is durable immediately: nothing later in the batch
      // can undo it (deliberate — the same semantics as bulk-submit).
      await runRequestContext({ bypass: true, firmId: null }, async () => {
        const kase: ClerkCase = await getCase(item.caseId);
        // Server-side fast-lane eligibility BEFORE any decision is applied —
        // the console computes the same predicate for display, but the
        // server owns the rule.
        const blocked = fastLaneBlocker(kase);
        if (blocked) throw new BulkSkip(blocked);
        await decideCase(item.caseId, item.decision, actorId);
      });
      results.push({ caseId: item.caseId, outcome: "approved", reason: null });
    } catch (err) {
      if (err instanceof BulkSkip) {
        skip(err.message);
        continue;
      }
      // A state race (decided elsewhere between the eligibility read and the
      // CAS) or any domain refusal marks THIS row skipped; the batch keeps
      // going — mirroring bulk-submit's per-row posture.
      if (err instanceof DomainError) {
        skip(
          err.code === "CASE_DECIDED_CONFLICT" ? "already decided" : err.message,
        );
      } else {
        skip("Approval failed unexpectedly");
      }
    }
  }

  const approved = results.filter((r) => r.outcome === "approved").length;
  // One summary event for the batch (each approval also appended its own
  // clerk.case.approve row inside decideCase). Anchored on the first case so
  // the event is queryable; the counts carry the batch shape.
  await appendAudit({
    actorId,
    action: "clerk.bulk.approve",
    entityType: "clerk_case",
    entityId: items[0]?.caseId ?? "none",
    after: {
      requested: items.length,
      approved,
      skipped: items.length - approved,
    },
  });

  return { results };
}
