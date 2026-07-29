import { and, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  firmPoliciesTable,
  invoiceApprovalsTable,
  usersTable,
  type InvoiceApprovalRow,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import { isUuid } from "../../lib/uuid";
// Circular with service.ts by design (service's submit guard calls back into
// assertSubmitApproved below): safe because both sides export hoisted function
// declarations and only reference each other inside call bodies, never at
// module-evaluation time.
import { assertReceivableOriented } from "./service";
import { RECEIVABLE_ORIENTATION } from "./receivables";
import { invoiceOrientation } from "./payables";

// Maker-checker submission approval (contract 0.45.0, firm_policies +
// invoice_approvals — lib/db/src/schema/governance.ts, RLS via migration
// 0024). The shape of the control:
//   - firm_policies.submit_approval_required is an OPT-IN firm policy; no row
//     means every default, so existing firms keep single-actor submit.
//   - An approval row is EVIDENCE: never deleted, only revoked (revokedAt) —
//     updateInvoiceContent revokes live approvals so an approval can never
//     cover content the approver did not see.
//   - The submit guard (assertSubmitApproved) demands a LIVE approval by a
//     principal OTHER than the submitter — dual control means two humans, not
//     one human clicking twice.

const APPROVAL_REQUIRED_MESSAGE =
  "This firm requires a second person's approval before submission — ask a colleague to review and approve this invoice first.";

// Only statuses from which a submission can still be reached (draft →
// validate → submit, failed → fix → re-submit). Approving post-submission
// paper would be meaningless evidence.
const APPROVABLE_STATUSES = ["draft", "validated", "failed"];

// The firm's submit-approval policy; no firm_policies row = default false
// (readers must treat "no row" as every policy at its default).
export async function firmSubmitApprovalRequired(
  firmId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({
      submitApprovalRequired: firmPoliciesTable.submitApprovalRequired,
    })
    .from(firmPoliciesTable)
    .where(eq(firmPoliciesTable.firmId, firmId))
    .limit(1);
  return row?.submitApprovalRequired ?? false;
}

// Lazy-upsert on the firm_id unique: the row is created on first write and
// updated in place after, stamping who changed it. Audited with pointer-safe
// booleans only (before/after policy state, never free text).
export async function updateFirmPolicies(
  firmId: string,
  input: { submitApprovalRequired: boolean },
  actorUserId: string,
): Promise<{ submitApprovalRequired: boolean }> {
  const before = await firmSubmitApprovalRequired(firmId);
  const [row] = await getDb()
    .insert(firmPoliciesTable)
    .values({
      firmId,
      submitApprovalRequired: input.submitApprovalRequired,
      updatedByUserId: actorUserId,
    })
    .onConflictDoUpdate({
      target: firmPoliciesTable.firmId,
      set: {
        submitApprovalRequired: input.submitApprovalRequired,
        updatedByUserId: actorUserId,
        // onConflictDoUpdate bypasses the column's $onUpdate hook, so the
        // freshness stamp is explicit.
        updatedAt: new Date(),
      },
    })
    .returning();
  await appendAudit({
    actorId: actorUserId,
    firmId,
    action: "firm.policies_update",
    entityType: "firm",
    entityId: firmId,
    before: { submitApprovalRequired: before },
    after: { submitApprovalRequired: row.submitApprovalRequired },
  });
  return { submitApprovalRequired: row.submitApprovalRequired };
}

// Record a submission approval. Guards mirror the submit path itself:
//   - orientation first — a BILL never enters the stamping lifecycle, so
//     approving one is the same 409 NOT_SUBMITTABLE the submit would earn;
//   - then state — only pre-submission paper (draft/validated/failed) can
//     collect an approval.
// The approver/submitter separation is NOT enforced here: an approval row is
// evidence anyone entitled may record; assertSubmitApproved is where "someone
// other than the submitter" bites.
export async function recordApproval(
  invoice: {
    id: string;
    firmId: string;
    supplierPartyId: string;
    buyerPartyId: string;
    status: string;
  },
  actorUserId: string,
  note?: string,
): Promise<InvoiceApprovalRow> {
  await assertReceivableOriented(invoice);
  if (!APPROVABLE_STATUSES.includes(invoice.status)) {
    throw new DomainError(
      "APPROVAL_BAD_STATE",
      `Invoice is ${invoice.status}; only a draft, validated or failed invoice can be approved for submission`,
      409,
    );
  }
  const [row] = await getDb()
    .insert(invoiceApprovalsTable)
    .values({
      firmId: invoice.firmId,
      invoiceId: invoice.id,
      approvedByUserId: actorUserId,
      note: note ?? null,
    })
    .returning();
  await appendAudit({
    actorId: actorUserId,
    firmId: invoice.firmId,
    action: "invoice.approve",
    entityType: "invoice",
    entityId: invoice.id,
    // Pointer-only: the approval id and the state it covered — the note is
    // free text and stays on the approval row.
    after: { approvalId: row.id, status: invoice.status },
  });
  return row;
}

// The contract InvoiceApproval view (openapi 0.45.0).
export interface ApprovalView {
  id: string;
  invoiceId: string;
  approvedByUserId: string;
  approvedByName: string | null;
  note: string | null;
  revokedAt: string | null;
  createdAt: Date;
}

// Map rows to the contract view with approvedByName batch-resolved from the
// users table. approved_by_user_id is FREE TEXT (mirrors lifecycle actor_id:
// the dev shim and out-of-band actors record non-uuid ids), so ids are
// uuid-filtered before touching the uuid-typed users.id column — the same
// isUuid guard modules/messaging/inbox.ts uses; name stays null otherwise.
export async function approvalViews(
  rows: InvoiceApprovalRow[],
): Promise<ApprovalView[]> {
  const userIds = [
    ...new Set(rows.map((r) => r.approvedByUserId).filter(isUuid)),
  ];
  const names = new Map<string, string | null>(
    userIds.length
      ? (
          await getDb()
            .select({ id: usersTable.id, fullName: usersTable.fullName })
            .from(usersTable)
            .where(inArray(usersTable.id, userIds))
        ).map((u): [string, string | null] => [u.id, u.fullName])
      : [],
  );
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    approvedByUserId: r.approvedByUserId,
    approvedByName: names.get(r.approvedByUserId) ?? null,
    note: r.note,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
    createdAt: r.createdAt,
  }));
}

// Approvals on an invoice, newest first, REVOKED ONES INCLUDED — the list is
// the evidence trail, not just the live state.
export async function listApprovals(invoiceId: string): Promise<ApprovalView[]> {
  const rows = await getDb()
    .select()
    .from(invoiceApprovalsTable)
    .where(eq(invoiceApprovalsTable.invoiceId, invoiceId))
    .orderBy(desc(invoiceApprovalsTable.createdAt));
  return approvalViews(rows);
}

// Approvals are evidence: revoked, never deleted. Called by
// updateInvoiceContent after any content change so no approval outlives the
// content the approver actually saw.
export async function revokeLiveApprovals(invoiceId: string): Promise<void> {
  await getDb()
    .update(invoiceApprovalsTable)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invoiceApprovalsTable.invoiceId, invoiceId),
        isNull(invoiceApprovalsTable.revokedAt),
      ),
    );
}

// Awaiting-approval visibility (round-17 idea #2). Under maker-checker a
// draft blocked on its second pair of eyes is invisible until someone goes
// looking — this is the one spelling of "waiting": policy ON, pre-submission
// receivable paper (the same APPROVABLE_STATUSES the recorder accepts), no
// live approval. Null when the policy is off — "0 waiting" and "the firm
// doesn't use approvals" must never read the same.
export interface PendingApprovals {
  count: number;
  oldestDays: number | null;
  // Oldest first, capped — enough for a digest line or an Ask answer.
  invoices: {
    invoiceId: string;
    invoiceNumber: string;
    status: string;
    ageDays: number;
  }[];
}

export async function pendingApprovals(
  firmId: string,
  clientPartyId?: string,
): Promise<PendingApprovals | null> {
  if (!(await firmSubmitApprovalRequired(firmId))) return null;
  const clientCond = clientPartyId
    ? sql`AND i.supplier_party_id = ${clientPartyId}`
    : sql``;
  // One spelling of the pending predicate, shared by the honest COUNT (no
  // row cap — "5000 waiting" must never mean "5000 or more") and the small
  // oldest-first sample.
  const pendingCond = sql`
    i.firm_id = ${firmId}
    AND i.kind = 'invoice'
    AND i.status IN ('draft', 'validated', 'failed')
    AND ${RECEIVABLE_ORIENTATION}
    ${clientCond}
    AND NOT EXISTS (
      SELECT 1 FROM invoice_approvals a
      WHERE a.invoice_id = i.id AND a.revoked_at IS NULL
    )`;
  const [agg] = (
    await getDb().execute<{ count: number; oldest_days: number | null }>(sql`
      SELECT COUNT(*)::int AS count,
        GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - MIN(i.created_at))) / 86400))::int AS oldest_days
      FROM invoices i
      WHERE ${pendingCond}
    `)
  ).rows;
  const count = Number(agg?.count ?? 0);
  const sample =
    count > 0
      ? (
          await getDb().execute<{
            id: string;
            invoice_number: string;
            status: string;
            age_days: number;
          }>(sql`
            SELECT i.id, i.invoice_number, i.status,
              GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - i.created_at)) / 86400))::int AS age_days
            FROM invoices i
            WHERE ${pendingCond}
            ORDER BY i.created_at ASC, i.id
            LIMIT 5
          `)
        ).rows
      : [];
  return {
    count,
    oldestDays: count > 0 ? Number(agg?.oldest_days ?? 0) : null,
    invoices: sample.map((r) => ({
      invoiceId: r.id,
      invoiceNumber: r.invoice_number,
      status: r.status,
      ageDays: Number(r.age_days),
    })),
  };
}

// Whether this invoice is blocked on the maker-checker policy right now —
// the status light's "why can't I submit?" input. False when the policy is
// off, the paper is past submission, a live approval exists, or the row is
// not submittable paper at all: a captured BILL and a credit note never
// enter the stamping lifecycle, so telling them they "await approval" would
// name a block that does not exist and direct the user into a guaranteed
// 409 — the same kind + orientation gate pendingApprovals applies.
export async function awaitingApproval(invoice: {
  id: string;
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  status: string;
  kind: string;
}): Promise<boolean> {
  if (invoice.kind !== "invoice") return false;
  if (!APPROVABLE_STATUSES.includes(invoice.status)) return false;
  if (!(await firmSubmitApprovalRequired(invoice.firmId))) return false;
  if ((await invoiceOrientation(invoice)) !== "receivable") return false;
  const [live] = await getDb()
    .select({ id: invoiceApprovalsTable.id })
    .from(invoiceApprovalsTable)
    .where(
      and(
        eq(invoiceApprovalsTable.invoiceId, invoice.id),
        isNull(invoiceApprovalsTable.revokedAt),
      ),
    )
    .limit(1);
  return !live;
}

// The submit guard. Policy off (or no policy row) is a no-op — nothing about
// the single-actor flow changes until a firm opts in. Policy on demands a
// LIVE approval by someone OTHER than the submitting actor; when the actor is
// unknown (system/worker paths carry no principal) any live approval counts —
// the human separation was enforced when the approval and the triggering
// action were recorded.
export async function assertSubmitApproved(
  invoice: { id: string; firmId: string },
  actorId: string | undefined,
): Promise<void> {
  if (!(await firmSubmitApprovalRequired(invoice.firmId))) return;
  const conditions: SQL[] = [
    eq(invoiceApprovalsTable.invoiceId, invoice.id),
    isNull(invoiceApprovalsTable.revokedAt),
  ];
  if (actorId !== undefined) {
    conditions.push(ne(invoiceApprovalsTable.approvedByUserId, actorId));
  }
  const [live] = await getDb()
    .select({ id: invoiceApprovalsTable.id })
    .from(invoiceApprovalsTable)
    .where(and(...conditions))
    .limit(1);
  if (!live) {
    throw new DomainError("APPROVAL_REQUIRED", APPROVAL_REQUIRED_MESSAGE, 409);
  }
}
