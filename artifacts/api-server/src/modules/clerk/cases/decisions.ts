import { and, eq, inArray } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  firmsTable,
  obligationsTable,
  type ClerkCase,
  type Obligation,
} from "@workspace/db";
import { DomainError } from "../../errors";
import { isUniqueViolation } from "../../../lib/pg-errors";
import { appendAudit } from "../../audit/audit";
import { createDraft, type LineInput } from "../../invoice/service";
import {
  computeCorrections,
  computeLineCorrections,
  computeNoticeCorrections,
} from "../corrections";
import {
  isIsoDate as isIsoNoticeDate,
  type NoticeAuthority,
  type NoticeTaxType,
  type NoticeType,
} from "../notice-prompts";
import { recordPartyAliases } from "../alias";
import { assertPartyInFirm, getCase } from "./lifecycle";

export interface CaseDecisionInput {
  action: "approve" | "reject" | "escalate";
  reason?: string | null;
  firmId?: string;
  supplierPartyId?: string;
  buyerPartyId?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string | null;
  currency?: string;
  category?: "b2b" | "b2g" | "b2c";
  lines?: LineInput[];
}

const DECIDABLE_STATUSES = new Set<ClerkCase["status"]>([
  "extracted",
  "in_review",
  "escalated",
  "failed",
]);

// The guard chain both decision lanes (decideCase / decideNoticeCase) run
// before touching anything: kind wall, decidable-status wall, claim-holder
// rule. `kindError` carries each lane's own CASE_BAD_KIND message.
function assertCaseDecidable(
  existing: ClerkCase,
  expectedKind: "extraction" | "notice",
  kindError: string,
  actorId: string,
): void {
  if (existing.kind !== expectedKind) {
    throw new DomainError("CASE_BAD_KIND", kindError, 409);
  }
  if (!DECIDABLE_STATUSES.has(existing.status)) {
    throw new DomainError(
      "CASE_BAD_STATE",
      `Case is '${existing.status}' and can no longer be decided`,
      409,
    );
  }
  // A claimed case is decided only by its holder; release it first to hand
  // over (any operator may release).
  if (
    existing.status === "in_review" &&
    existing.claimedBy &&
    existing.claimedBy !== actorId
  ) {
    throw new DomainError(
      "CASE_CLAIMED",
      "Another operator has claimed this case. Release it first to take over.",
      409,
    );
  }
}

// The reject/escalate arm both lanes share. Compare-and-set on status: the
// guard pre-checks read without a lock, so two concurrent decisions could
// both pass them — the UPDATE's status condition makes the second one find
// zero rows instead of silently overwriting the first (row-lock + READ
// COMMITTED re-evaluation). The audit action prefix stays per-lane
// ("clerk.case." vs "clerk.notice.") — reports and dashboards key on the
// exact strings, so it is a parameter, never unified.
async function applyRejectOrEscalate(
  id: string,
  existing: ClerkCase,
  action: "reject" | "escalate",
  reason: string | null | undefined,
  actorId: string,
  auditActionPrefix: "clerk.case." | "clerk.notice.",
): Promise<ClerkCase> {
  const [row] = await getDb()
    .update(clerkCasesTable)
    .set({
      status: action === "reject" ? "rejected" : "escalated",
      decidedBy: actorId,
      decisionAction: action,
      decisionReason: reason ?? null,
    })
    .where(
      and(
        eq(clerkCasesTable.id, id),
        inArray(clerkCasesTable.status, [...DECIDABLE_STATUSES]),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_DECIDED_CONFLICT",
      "Another operator decided this case first",
      409,
    );
  }
  await appendAudit({
    actorId,
    action: `${auditActionPrefix}${action}`,
    entityType: "clerk_case",
    entityId: id,
    before: { status: existing.status },
    after: { status: row.status, reason: reason ?? null },
  });
  return row;
}

// Approve-side firm validation both lanes share: the named firm must exist,
// and a client-captured case belongs to its firm — approving it into a
// DIFFERENT firm would re-attribute one firm's document (and, on the invoice
// lane, its exemplar pool) to another. Operator captures (no firm) are
// attributed here as before.
async function assertApprovalFirm(
  existing: ClerkCase,
  firmId: string,
): Promise<void> {
  const [firm] = await getDb()
    .select({ id: firmsTable.id })
    .from(firmsTable)
    .where(eq(firmsTable.id, firmId))
    .limit(1);
  if (!firm) throw new DomainError("FIRM_NOT_FOUND", "Firm not found", 404);
  if (existing.firmId && existing.firmId !== firmId) {
    throw new DomainError(
      "CASE_FIRM_MISMATCH",
      "This case was captured for a different firm than the approval names.",
      409,
    );
  }
}

export async function decideCase(
  id: string,
  input: CaseDecisionInput,
  actorId: string,
): Promise<ClerkCase> {
  const existing = await getCase(id);
  assertCaseDecidable(
    existing,
    "extraction",
    "Only extraction cases take review decisions",
    actorId,
  );

  if (input.action === "reject" || input.action === "escalate") {
    return applyRejectOrEscalate(
      id,
      existing,
      input.action,
      input.reason,
      actorId,
      "clerk.case.",
    );
  }

  // Approve: the operator must have confirmed every value that goes into the
  // draft — the extraction is never trusted on its own. Approval creates a
  // DRAFT invoice through the standard createDraft path and nothing more.
  if (existing.status !== "extracted" && existing.status !== "in_review") {
    throw new DomainError(
      "CASE_BAD_STATE",
      `A '${existing.status}' case cannot be approved`,
      409,
    );
  }
  const missing: string[] = [];
  if (!input.firmId) missing.push("firmId");
  if (!input.supplierPartyId) missing.push("supplierPartyId");
  if (!input.buyerPartyId) missing.push("buyerPartyId");
  if (!input.invoiceNumber) missing.push("invoiceNumber");
  if (!input.issueDate) missing.push("issueDate");
  if (!input.lines || input.lines.length === 0) missing.push("lines");
  if (missing.length > 0) {
    throw new DomainError(
      "DECISION_INCOMPLETE",
      `Approval requires operator-confirmed values for: ${missing.join(", ")}`,
      400,
    );
  }

  await assertApprovalFirm(existing, input.firmId!);

  await assertPartyInFirm(input.firmId!, input.supplierPartyId!, "supplier");
  await assertPartyInFirm(input.firmId!, input.buyerPartyId!, "buyer");

  const { invoice } = await createDraft(
    {
      firmId: input.firmId!,
      supplierPartyId: input.supplierPartyId!,
      buyerPartyId: input.buyerPartyId!,
      invoiceNumber: input.invoiceNumber!,
      issueDate: input.issueDate!,
      dueDate: input.dueDate ?? null,
      currency: input.currency,
      category: input.category,
      lines: input.lines!,
    },
    actorId,
  );

  const corrections = [
    ...computeCorrections(existing.extraction, {
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate ?? null,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      grandTotal: invoice.grandTotal,
    }),
    ...computeLineCorrections(
      existing.extraction?.lines ?? [],
      (input.lines ?? []).map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        vatRate: l.vatRate ?? null,
      })),
    ),
  ];

  // Same compare-and-set as reject/escalate. Approval creates the draft
  // BEFORE this update, so the losing side of a concurrent double-approve
  // must not keep its draft: the 409 rolls back the request transaction and
  // the draft with it (the 4xx rollback rule), leaving exactly one approved
  // decision and one invoice.
  const [row] = await getDb()
    .update(clerkCasesTable)
    .set({
      status: "approved",
      firmId: input.firmId!,
      decidedBy: actorId,
      decisionAction: "approve",
      decisionReason: input.reason ?? null,
      corrections,
      createdInvoiceId: invoice.id,
    })
    .where(
      and(
        eq(clerkCasesTable.id, id),
        inArray(clerkCasesTable.status, ["extracted", "in_review"]),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_DECIDED_CONFLICT",
      "Another operator decided this case first",
      409,
    );
  }
  await appendAudit({
    actorId,
    action: "clerk.case.approve",
    entityType: "clerk_case",
    entityId: id,
    before: { status: existing.status },
    after: {
      status: "approved",
      createdInvoiceId: invoice.id,
      invoiceStatus: invoice.status,
      firmId: input.firmId!,
    },
  });

  // Alias memory (exhaust idea #6): the approval just paired the DOCUMENT's
  // names with human-confirmed register parties — remember both. Best-effort
  // and fully self-contained on the raw pool (register-name reads included):
  // nothing here can touch the ambient transaction, so the approval can
  // never fail over exhaust.
  const extractedField = (field: string): string | null =>
    existing.extraction?.fields.find((f) => f.field === field)?.value ?? null;
  await recordPartyAliases(input.firmId ?? null, [
    {
      extractedName: extractedField("supplierName"),
      partyId: input.supplierPartyId!,
    },
    {
      extractedName: extractedField("buyerName"),
      partyId: input.buyerPartyId!,
    },
  ]);
  return row;
}

export interface NoticeDecisionInput {
  action: "approve" | "reject" | "escalate";
  reason?: string | null;
  firmId?: string;
  clientPartyId?: string;
  noticeType?: NoticeType;
  authority?: NoticeAuthority;
  reference?: string | null;
  taxType?: NoticeTaxType | null;
  period?: string | null;
  amount?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  responseDueDate?: string;
  notes?: string | null;
}

export interface NoticeDecisionResult {
  case: ClerkCase;
  obligation?: Obligation;
}

// The notice twin of decideCase: same decidable statuses, same claim-holder
// rule, same compare-and-set discipline — but approval creates an OPEN
// OBLIGATION (the tracked "respond to this authority by this date" record),
// never an invoice. The obligations.sourceCaseId unique index is the
// double-approve backstop: two concurrent approvals both pass the status
// pre-read, but only one insert can win — the loser 409s and (inside the
// request transaction) rolls back. There is no createdObligationId column on
// the case; the obligation carries sourceCaseId, so the link reads backwards.
export async function decideNoticeCase(
  id: string,
  input: NoticeDecisionInput,
  actorId: string,
): Promise<NoticeDecisionResult> {
  const existing = await getCase(id);
  assertCaseDecidable(
    existing,
    "notice",
    "Only notice cases take notice decisions",
    actorId,
  );

  if (input.action === "reject" || input.action === "escalate") {
    const row = await applyRejectOrEscalate(
      id,
      existing,
      input.action,
      input.reason,
      actorId,
      "clerk.notice.",
    );
    return { case: row };
  }

  // Approve: the operator must have confirmed every value that anchors the
  // obligation — the extraction is never trusted on its own.
  if (existing.status !== "extracted" && existing.status !== "in_review") {
    throw new DomainError(
      "CASE_BAD_STATE",
      `A '${existing.status}' case cannot be approved`,
      409,
    );
  }
  const missing: string[] = [];
  if (!input.firmId) missing.push("firmId");
  if (!input.clientPartyId) missing.push("clientPartyId");
  if (!input.noticeType) missing.push("noticeType");
  if (!input.authority) missing.push("authority");
  if (!input.responseDueDate) missing.push("responseDueDate");
  if (missing.length > 0) {
    throw new DomainError(
      "DECISION_INCOMPLETE",
      `Approval requires operator-confirmed values for: ${missing.join(", ")}`,
      400,
    );
  }
  // The due date is THE clock every downstream surface (reminders, digests,
  // month-end) computes from — a malformed value must never reach the row.
  if (!isIsoNoticeDate(input.responseDueDate!)) {
    throw new DomainError(
      "DECISION_INVALID",
      `responseDueDate "${input.responseDueDate}" is not a valid YYYY-MM-DD date`,
      400,
    );
  }
  if (input.issueDate != null && !isIsoNoticeDate(input.issueDate)) {
    throw new DomainError(
      "DECISION_INVALID",
      `issueDate "${input.issueDate}" is not a valid YYYY-MM-DD date`,
      400,
    );
  }
  // amount lands in a numeric column: refuse a non-number here (a clean 400)
  // rather than letting Postgres throw a 500 at insert time.
  if (
    input.amount != null &&
    (input.amount.trim() === "" || !Number.isFinite(Number(input.amount)))
  ) {
    throw new DomainError(
      "DECISION_INVALID",
      `amount "${input.amount}" is not a plain decimal number`,
      400,
    );
  }

  await assertApprovalFirm(existing, input.firmId!);
  await assertPartyInFirm(input.firmId!, input.clientPartyId!, "client");

  let obligation: Obligation;
  try {
    [obligation] = await getDb()
      .insert(obligationsTable)
      .values({
        firmId: input.firmId!,
        clientPartyId: input.clientPartyId!,
        sourceCaseId: id,
        noticeType: input.noticeType!,
        authority: input.authority!,
        reference: input.reference ?? null,
        taxType: input.taxType ?? null,
        period: input.period ?? null,
        amount: input.amount ?? null,
        currency: input.currency ?? null,
        issueDate: input.issueDate ?? null,
        responseDueDate: input.responseDueDate!,
        notes: input.notes ?? null,
        createdBy: actorId,
      })
      .returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The sourceCaseId unique index caught a concurrent approve that the
      // status pre-read raced past.
      throw new DomainError(
        "CASE_DECIDED_CONFLICT",
        "Another operator decided this case first",
        409,
      );
    }
    throw err;
  }

  const corrections = computeNoticeCorrections(existing.noticeExtraction, {
    noticeType: input.noticeType!,
    authority: input.authority!,
    reference: input.reference ?? null,
    taxType: input.taxType ?? null,
    period: input.period ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    issueDate: input.issueDate ?? null,
    responseDueDate: input.responseDueDate!,
  });

  // Same compare-and-set as decideCase's approve arm. The obligation was
  // inserted BEFORE this update, so the losing side of a race must not keep
  // it: the 409 rolls back the request transaction (the 4xx rollback rule),
  // leaving exactly one approved decision and one obligation.
  const [row] = await getDb()
    .update(clerkCasesTable)
    .set({
      status: "approved",
      firmId: input.firmId!,
      decidedBy: actorId,
      decisionAction: "approve",
      decisionReason: input.reason ?? null,
      corrections,
    })
    .where(
      and(
        eq(clerkCasesTable.id, id),
        inArray(clerkCasesTable.status, ["extracted", "in_review"]),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_DECIDED_CONFLICT",
      "Another operator decided this case first",
      409,
    );
  }
  await appendAudit({
    actorId,
    action: "clerk.notice.approve",
    entityType: "clerk_case",
    entityId: id,
    before: { status: existing.status },
    after: {
      status: "approved",
      obligationId: obligation.id,
      responseDueDate: input.responseDueDate!,
      firmId: input.firmId!,
    },
  });
  return { case: row, obligation };
}
