import { createHash } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkSourceArtifactsTable,
  clerkFieldCandidatesTable,
  clerkReviewDecisionsTable,
  type ClerkCaseRow,
  type ClerkFieldCandidateRow,
  type ClerkReviewDecisionRow,
  type ClerkSourceArtifactRow,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import {
  CONFIDENCE_THRESHOLD,
  CRITICAL_FIELDS,
  EXTRACTOR_VERSION,
  containsSecretMaterial,
  extractInvoiceFields,
  listRunsForCase,
  runInference,
} from "./gateway";

// The Clerk workflow orchestrator: a bounded state machine (Supplemental §4,
// Appendix A1). Every transition is compare-and-set so concurrent operators
// cannot fork a case, and the only "tools" the pipeline can invoke are the
// module-internal functions below — there is no submitInvoice here, and none
// can be added by input: absence of capability, which is stronger than policy
// (CLK-OPS-03).

type CaseState = ClerkCaseRow["state"];

// Allowed transitions (Appendix A1). "Edited" is a review decision, not a
// state — an edit loops the case back through ready_for_review.
const TRANSITIONS: Record<CaseState, CaseState[]> = {
  received: ["consent_checked", "rejected"],
  consent_checked: ["quarantined", "refused"],
  quarantined: ["pre_processed", "escalated"],
  pre_processed: ["draft_mapped", "escalated"],
  draft_mapped: ["clarification_required", "ready_for_review"],
  clarification_required: ["draft_mapped", "ready_for_review", "escalated"],
  ready_for_review: ["ready_for_review", "approved", "rejected", "escalated"],
  approved: ["validated"],
  validated: ["awaiting_submission_approval"],
  awaiting_submission_approval: ["queued", "closed"],
  queued: ["closed"],
  closed: [],
  rejected: [],
  refused: [],
  escalated: [],
};

export async function applyCaseTransition(
  caseId: string,
  to: CaseState,
  patch: Partial<typeof clerkCasesTable.$inferInsert> = {},
): Promise<ClerkCaseRow> {
  const from = (Object.keys(TRANSITIONS) as CaseState[]).filter((s) =>
    TRANSITIONS[s].includes(to),
  );
  const rows = await getDb()
    .update(clerkCasesTable)
    .set({ state: to, ...patch })
    .where(
      and(
        eq(clerkCasesTable.id, caseId),
        sql`${clerkCasesTable.state} IN (${sql.join(
          from.map((s) => sql`${s}`),
          sql`, `,
        )})`,
      ),
    )
    .returning();
  if (rows.length === 0) {
    throw new DomainError(
      "CASE_STATE_CONFLICT",
      `Case cannot transition to ${to} from its current state`,
      409,
    );
  }
  return rows[0];
}

export interface CaseActor {
  userId: string;
  role: string;
}

export interface CreateCaseInput {
  firmId: string;
  clientPartyId: string;
  sourceText: string;
  filename?: string;
  language?: string;
  priority?: "low" | "medium" | "high";
}

export interface CaseDetail {
  caseRow: ClerkCaseRow;
  sources: ClerkSourceArtifactRow[];
  candidates: ClerkFieldCandidateRow[];
  decisions: ClerkReviewDecisionRow[];
}

// Intake pipeline: received → consent_checked → quarantined → pre_processed →
// draft_mapped → clarification_required | ready_for_review. Runs inline (the
// synthetic extractor is cheap); a real model would run the same stages from
// a worker. Any gateway block or security finding lands in a terminal state
// with the reason recorded — never a silent success.
export async function createCase(
  input: CreateCaseInput,
  actor: CaseActor,
): Promise<CaseDetail> {
  const [caseRow] = await getDb()
    .insert(clerkCasesTable)
    .values({
      firmId: input.firmId,
      clientPartyId: input.clientPartyId,
      channel: "console",
      state: "received",
      priority: input.priority ?? "medium",
      language: input.language ?? "en",
      intent: "invoice.capture",
      createdByUserId: actor.userId,
    })
    .returning();
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    firmId: input.firmId,
    action: "clerk.case.created",
    entityType: "clerk_case",
    entityId: caseRow.id,
  });

  // Consent gate: intake here is layer-one processing of the client's own
  // data by an authenticated, party-scoped principal (the route asserts party
  // access before we get here). Channel consent for WhatsApp intake is a
  // C2 concern and stays dark (CLK-MSG-01).
  let current = await applyCaseTransition(caseRow.id, "consent_checked");

  // Quarantine (CLK-CAP-03, CLK-SEC-08): reject oversized input and secret
  // material before anything downstream sees it.
  current = await applyCaseTransition(caseRow.id, "quarantined");
  if (containsSecretMaterial(input.sourceText)) {
    current = await applyCaseTransition(caseRow.id, "escalated", {
      escalationReason:
        "Source appears to contain credentials or secret material (quarantined).",
    });
    await appendAudit({
      actorId: actor.userId,
      actorRole: actor.role,
      firmId: input.firmId,
      action: "clerk.media.quarantined",
      entityType: "clerk_case",
      entityId: caseRow.id,
    });
    return { caseRow: current, sources: [], candidates: [], decisions: [] };
  }
  current = await applyCaseTransition(caseRow.id, "pre_processed");

  const [source] = await getDb()
    .insert(clerkSourceArtifactsTable)
    .values({
      caseId: caseRow.id,
      kind: "text",
      filename: input.filename ?? null,
      mime: "text/plain",
      contentText: input.sourceText,
      contentHash: createHash("sha256").update(input.sourceText).digest("hex"),
    })
    .returning();

  // Extraction through the gateway (kill-switch aware, full provenance).
  const result = await runInference({
    firmId: input.firmId,
    caseId: caseRow.id,
    purpose: "extraction",
    model: "synthetic-extractor",
    promptVersion: EXTRACTOR_VERSION,
    input: input.sourceText,
    run: extractInvoiceFields,
  });

  if (result.outcome !== "allowed" || !result.output) {
    current = await applyCaseTransition(caseRow.id, "escalated", {
      escalationReason:
        result.outcome === "blocked"
          ? (result.blockedReason ?? "Clerk extraction is disabled")
          : "Extraction failed; the case needs manual handling.",
    });
    return {
      caseRow: current,
      sources: [source],
      candidates: [],
      decisions: [],
    };
  }

  const candidates: ClerkFieldCandidateRow[] = [];
  for (const f of result.output.fields) {
    const [candidate] = await getDb()
      .insert(clerkFieldCandidatesTable)
      .values({
        caseId: caseRow.id,
        fieldKey: f.fieldKey,
        value: f.value,
        confidence: f.confidence.toFixed(3),
        critical: CRITICAL_FIELDS.has(f.fieldKey),
        sourceArtifactId: source.id,
        sourceRegion: { line: f.line, start: f.start, end: f.end },
        extractorVersion: EXTRACTOR_VERSION,
        reviewState: "proposed",
      })
      .returning();
    candidates.push(candidate);
  }
  current = await applyCaseTransition(caseRow.id, "draft_mapped");

  // Confidence routing (CLK-AI-05, CLK-CAP-06): a missing critical field or a
  // below-threshold candidate means the case needs clarification; either way
  // nothing is auto-filled — candidates stay "proposed" until a named human
  // confirms them.
  const foundKeys = new Set(candidates.map((c) => c.fieldKey));
  const missingCritical = [...CRITICAL_FIELDS].filter(
    (k) => !foundKeys.has(k),
  );
  const lowConfidence = candidates.some(
    (c) => Number(c.confidence) < CONFIDENCE_THRESHOLD,
  );
  current = await applyCaseTransition(
    caseRow.id,
    missingCritical.length > 0 || lowConfidence
      ? "clarification_required"
      : "ready_for_review",
  );

  return { caseRow: current, sources: [source], candidates, decisions: [] };
}

// firmId null = cross-tenant staff (operator/auditor run in RLS bypass);
// firm principals are constrained to their own firm both here and by RLS.
export async function loadCaseForFirm(
  id: string,
  firmId: string | null,
): Promise<ClerkCaseRow> {
  const conditions = [eq(clerkCasesTable.id, id)];
  if (firmId) conditions.push(eq(clerkCasesTable.firmId, firmId));
  const [row] = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(and(...conditions))
    .limit(1);
  if (!row) throw new DomainError("NOT_FOUND", "Clerk case not found", 404);
  return row;
}

export async function getCaseDetail(
  id: string,
  firmId: string | null,
): Promise<CaseDetail & { runs: Awaited<ReturnType<typeof listRunsForCase>> }> {
  const caseRow = await loadCaseForFirm(id, firmId);
  const [sources, candidates, decisions, runs] = await Promise.all([
    getDb()
      .select()
      .from(clerkSourceArtifactsTable)
      .where(eq(clerkSourceArtifactsTable.caseId, id))
      .orderBy(asc(clerkSourceArtifactsTable.createdAt)),
    getDb()
      .select()
      .from(clerkFieldCandidatesTable)
      .where(eq(clerkFieldCandidatesTable.caseId, id))
      .orderBy(asc(clerkFieldCandidatesTable.createdAt)),
    getDb()
      .select()
      .from(clerkReviewDecisionsTable)
      .where(eq(clerkReviewDecisionsTable.caseId, id))
      .orderBy(asc(clerkReviewDecisionsTable.createdAt)),
    listRunsForCase(id),
  ]);
  return { caseRow, sources, candidates, decisions, runs };
}

export async function listCases(filter: {
  firmId: string | null;
  clientPartyId?: string;
  state?: string;
}): Promise<ClerkCaseRow[]> {
  const conditions = [];
  if (filter.firmId) conditions.push(eq(clerkCasesTable.firmId, filter.firmId));
  if (filter.clientPartyId) {
    conditions.push(eq(clerkCasesTable.clientPartyId, filter.clientPartyId));
  }
  if (filter.state) {
    conditions.push(eq(clerkCasesTable.state, filter.state as CaseState));
  }
  // Queue order (CLK-OPS-05): open work first by priority, then oldest first.
  const base = getDb().select().from(clerkCasesTable);
  return (conditions.length ? base.where(and(...conditions)) : base)
    .orderBy(
      sql`CASE ${clerkCasesTable.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
      asc(clerkCasesTable.createdAt),
    )
    .limit(500);
}

export interface ReviewInput {
  decision: "approve" | "edit" | "reject" | "escalate";
  reasonCode: string;
  fields?: {
    candidateId: string;
    action: "confirm" | "edit" | "reject";
    value?: string;
  }[];
}

// Operator review (CLK-OPS-01/02): named actor, explicit decision, reason
// code and before/after diff. Approval requires every critical candidate to
// be human-confirmed — the machine's own confidence is never enough
// (CLK-CAP-06), and approval parks the case at awaiting_submission_approval:
// the actual submission stays a separate explicit action in the normal
// invoice workflow (CLK-OPS-03 — Clerk has no submission authority).
export async function reviewCase(
  caseId: string,
  firmId: string | null,
  actor: CaseActor,
  input: ReviewInput,
): Promise<void> {
  const caseRow = await loadCaseForFirm(caseId, firmId);
  if (
    caseRow.state !== "ready_for_review" &&
    caseRow.state !== "clarification_required"
  ) {
    throw new DomainError(
      "CASE_STATE_CONFLICT",
      "Case is not awaiting review",
      409,
    );
  }

  const candidates = await getDb()
    .select()
    .from(clerkFieldCandidatesTable)
    .where(eq(clerkFieldCandidatesTable.caseId, caseId));
  const byId = new Map(candidates.map((c) => [c.id, c]));

  // Apply field-level review actions first, collecting the diff.
  const diff: Record<string, { before: string | null; after: string | null }> =
    {};
  for (const f of input.fields ?? []) {
    const candidate = byId.get(f.candidateId);
    if (!candidate) {
      throw new DomainError(
        "NOT_FOUND",
        `Field candidate ${f.candidateId} is not part of this case`,
        404,
      );
    }
    if (f.action === "edit" && (f.value === undefined || f.value === "")) {
      throw new DomainError(
        "REVIEW_INVALID",
        "An edited field needs a replacement value",
        400,
      );
    }
    const reviewState =
      f.action === "confirm"
        ? "confirmed"
        : f.action === "edit"
          ? "edited"
          : "rejected";
    await getDb()
      .update(clerkFieldCandidatesTable)
      .set({
        reviewState,
        editedValue: f.action === "edit" ? (f.value ?? null) : null,
      })
      .where(eq(clerkFieldCandidatesTable.id, f.candidateId));
    diff[candidate.fieldKey] = {
      before: candidate.value,
      after:
        f.action === "edit"
          ? (f.value ?? null)
          : f.action === "confirm"
            ? candidate.value
            : null,
    };
    // Update the in-memory copy so the approval check below sees the result.
    candidate.reviewState = reviewState;
  }

  if (input.decision === "approve") {
    const unconfirmedCritical = candidates.filter(
      (c) =>
        c.critical &&
        c.reviewState !== "confirmed" &&
        c.reviewState !== "edited" &&
        c.reviewState !== "rejected",
    );
    if (unconfirmedCritical.length > 0) {
      throw new DomainError(
        "CRITICAL_FIELDS_UNCONFIRMED",
        `Critical fields need explicit confirmation before approval: ${unconfirmedCritical
          .map((c) => c.fieldKey)
          .join(", ")}`,
        409,
      );
    }
  }

  await getDb().insert(clerkReviewDecisionsTable).values({
    caseId,
    actorUserId: actor.userId,
    actorRole: actor.role,
    decision: input.decision,
    reasonCode: input.reasonCode,
    diff: Object.keys(diff).length > 0 ? diff : null,
  });
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    firmId,
    action: "clerk.review.decided",
    entityType: "clerk_case",
    entityId: caseId,
    after: { decision: input.decision, reasonCode: input.reasonCode },
  });

  if (input.decision === "edit") {
    // An edit keeps the case in (or moves it to) review.
    if (caseRow.state === "clarification_required") {
      await applyCaseTransition(caseId, "ready_for_review");
    }
    return;
  }
  if (input.decision === "reject") {
    await applyCaseTransition(caseId, "rejected");
    return;
  }
  if (input.decision === "escalate") {
    await applyCaseTransition(caseId, "escalated", {
      escalationReason: input.reasonCode,
    });
    return;
  }
  // Approve: walk the deterministic tail of the state machine. The case parks
  // at awaiting_submission_approval — a human continues in the normal invoice
  // flow; Clerk cannot queue a submission.
  if (caseRow.state === "clarification_required") {
    await applyCaseTransition(caseId, "ready_for_review");
  }
  await applyCaseTransition(caseId, "approved");
  await applyCaseTransition(caseId, "validated");
  await applyCaseTransition(caseId, "awaiting_submission_approval");
}
