import {
  and,
  asc,
  desc,
  eq,
  isNull,
  notInArray,
  or,
} from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  engagementsTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  type ClerkCase,
} from "@workspace/db";
import { DomainError } from "../../errors";
import { appendAudit } from "../../audit/audit";
import {
  assertClerkEnabled,
  sha256,
  type ClerkGateway,
  type UserContent,
} from "../gateway";
import {
  transcribeAndLedger,
  transcribeVoiceProd,
  type VoiceTranscriber,
} from "../provider";
import { findExtractionExemplar } from "../exemplar";
import { firmFastLaneThreshold } from "../metrics";
import { inClerkScope } from "../scope";
import {
  INVOICE_CONTENT_BUILDERS,
  NOTICE_CONTENT_BUILDERS,
  MAX_SCAN_PAGES,
  decodeBase64Checked,
  extractPdfText,
  fenceDocument,
  rasterizePdfScan,
  resolveTextSource,
} from "./documents";
import { runExtraction, runNoticeExtraction } from "./extraction";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

export interface CreateCaseInput {
  sourceType: "image" | "pdf" | "text" | "voice";
  // Notice Desk: what the document IS. Absent = "invoice" (historic
  // behavior); "notice" runs the same capture rails into a kind "notice"
  // case with the notice extraction lane and its own approve path.
  documentKind?: "invoice" | "notice";
  name?: string | null;
  contentType?: string | null;
  imageBase64?: string;
  pdfBase64?: string;
  text?: string;
  audioBase64?: string;
  // Recorder-reported voice-note length in seconds (voice sources only).
  durationSec?: number | null;
  // INTERNAL (scan-bundle processor only, never on the API surface): pages
  // already rasterized from a validated segment of a scanned bundle. With
  // sourceType "pdf", these skip decode/rasterize and walk the ordinary
  // vision path; the duplicate hash keys on the page bytes, so the same
  // bundle re-queued dedupes segment by segment.
  scanPagesB64?: string[];
  // Bypass the duplicate-document guard after the operator has seen the
  // warning and decided the second case is intentional.
  allowDuplicate?: boolean;
}

// A provider blip shouldn't force re-uploading the document: retry re-runs
// extraction on the stored source. Only failed cases qualify — escalated
// cases had a *successful* call whose output was rejected, which a human
// should look at rather than re-roll.
// Firm attribution for client-facing capture (Clerk expansion A): the case
// row and every ledgered model call carry the firm the work was done for, so
// RLS scoping and the per-firm budget both hold. Operator captures pass no
// firm (cross-tenant, uncapped) — the pre-expansion behaviour.
export interface CaseContext {
  firmId?: string | null;
  // True when the capture was initiated by a client_user: supplier-memory
  // exemplars then narrow to that user's OWN cases — firm-keyed sharing is
  // not sufficient between sibling clients (SEC-03), and a fixture is client
  // document content.
  clientScoped?: boolean;
  // The capturing client_user's OWN party (SEC-03): register-history preflight
  // checks are scoped to it so a client can never read a sibling's ledger.
  clientPartyId?: string | null;
  // Set by the async-batch processor so the review queue can group a
  // bundle's segments together. Never an API input.
  batchId?: string | null;
}

// The client party a case's CREATOR is confined to, or null when the creator
// is not a client_user. Used to scope register-history preflight on retry to
// whoever will ultimately read the case (SEC-03) — regardless of who (an
// operator) triggers the retry. Also the async-batch processor's scope source.
export async function creatorClientParty(
  userId: string | null,
): Promise<string | null> {
  if (!userId) return null;
  const rows = await runInBypassContext(() =>
    getDb()
      .select({
        role: membershipsTable.role,
        clientPartyId: membershipsTable.clientPartyId,
      })
      .from(membershipsTable)
      .where(eq(membershipsTable.userId, userId))
      // Deterministic pick for a user with several client memberships: the
      // OLDEST client_user row wins, every time — an unordered scan would let
      // the plan decide which sibling party scopes the preflight (SEC-03).
      // Same rule as the inbound email rail's sender resolution.
      .orderBy(asc(membershipsTable.createdAt)),
  );
  const clientMembership = rows.find((r) => r.role === "client_user");
  return clientMembership?.clientPartyId ?? null;
}

export async function retryExtraction(
  id: string,
  actorId: string,
  gateway: ClerkGateway,
): Promise<ClerkCase> {
  await assertClerkEnabled();
  const existing = await getCase(id);
  if (
    (existing.kind !== "extraction" && existing.kind !== "notice") ||
    existing.status !== "failed"
  ) {
    throw new DomainError(
      "CASE_BAD_STATE",
      `Only failed extraction and notice cases can be retried (state is '${existing.status}')`,
      409,
    );
  }
  // Retry re-runs the lane the case was captured for: the stored source is
  // re-fenced with the SAME wording (notice or invoice) first-time intake
  // used — both paths read the same builder table, so they cannot drift.
  const notice = existing.kind === "notice";
  const build = notice ? NOTICE_CONTENT_BUILDERS : INVOICE_CONTENT_BUILDERS;
  let user: UserContent;
  let inputForHash: string;
  if (existing.sourceScanPagesB64?.length) {
    inputForHash = existing.sourceScanPagesB64.join("");
    user = build.scan(existing.sourceScanPagesB64);
  } else if (existing.sourceImageB64) {
    inputForHash = existing.sourceImageB64;
    // image/png is hardcoded because the case row does not persist the
    // original contentType, so a non-png upload retries with a png data URL
    // (pre-existing behaviour, preserved).
    user = build.image("image/png", existing.sourceImageB64);
  } else if (existing.sourceText) {
    inputForHash = existing.sourceText;
    user = build.fence(existing.sourceText);
  } else {
    throw new DomainError(
      "CASE_NO_SOURCE",
      "This case has no stored source to retry from",
      409,
    );
  }
  const exemplar =
    !notice && existing.sourceText && existing.firmId
      ? await findExtractionExemplar(existing.sourceText, existing.firmId)
      : null;
  const updated = notice
    ? await runNoticeExtraction(
        id,
        user,
        inputForHash,
        gateway,
        existing.firmId,
      )
    : await runExtraction(
        id,
        user,
        inputForHash,
        gateway,
        existing.firmId,
        exemplar,
        // Scope by the case's OWNER, not the (operator) retrier: the
        // client_user who created the case is the one who reads its
        // preflight (SEC-03).
        await creatorClientParty(existing.createdBy),
      );
  // The retry route runs OUTSIDE the request transaction (app.ts
  // NO_CONTEXT_ROUTE_PATTERNS) — with no ambient context, appendAudit's
  // getDb() is the raw pool and the event commits in its own transaction, so
  // this write is durable on that path too.
  await appendAudit({
    actorId,
    action: "clerk.case.retry",
    entityType: "clerk_case",
    entityId: id,
    before: { status: existing.status },
    after: { status: updated.status },
  });
  return updated;
}

export async function createExtractionCase(
  input: CreateCaseInput,
  actorId: string,
  gateway: ClerkGateway,
  transcriber: VoiceTranscriber = transcribeVoiceProd,
  ctx: CaseContext = {},
): Promise<ClerkCase> {
  await assertClerkEnabled();

  const notice = input.documentKind === "notice";
  // A read-aloud notice has no authoritative text: statutory deadlines and
  // reference numbers must come off the letter itself, never a paraphrase.
  // Rejected BEFORE any transcription call so no tokens are spent on it.
  if (notice && input.sourceType === "voice") {
    throw new DomainError(
      "NOTICE_SOURCE_UNSUPPORTED",
      "A voice note cannot capture a tax-authority notice — the letter itself is the authoritative text. Upload a photo, scan or the notice text instead.",
      400,
    );
  }

  const build = notice ? NOTICE_CONTENT_BUILDERS : INVOICE_CONTENT_BUILDERS;
  let sourceText: string | null = null;
  let sourceImageB64: string | null = null;
  let sourceScanPagesB64: string[] | null = null;
  let user: UserContent;
  let inputForHash: string;

  if (input.sourceType === "voice") {
    // C1 scope: English voice notes. The audio is transcribed on intake and
    // then handled exactly like a text document; ONLY the transcript is kept
    // (OPEN-8 minimisation — raw audio is never persisted). The transcription
    // itself is a model call, so it lands in the append-only ledger like any
    // other, success or failure.
    if (!input.audioBase64) {
      throw new DomainError(
        "BAD_UPLOAD",
        "audioBase64 is required for a voice source",
        400,
      );
    }
    const buf = decodeBase64Checked(input.audioBase64, "Audio");
    const transcript = await transcribeAndLedger(
      buf,
      ctx.firmId ?? null,
      transcriber,
    );
    if (!transcript) {
      throw new DomainError(
        "VOICE_NO_SPEECH",
        "No speech was detected in the voice note. Re-record it, or type the details instead.",
        422,
      );
    }
    sourceText = transcript;
    inputForHash = transcript;
    user = fenceDocument(transcript);
  } else if (input.sourceType === "text") {
    const text = await resolveTextSource(input.sourceType, input, "");
    sourceText = text;
    inputForHash = text;
    user = build.fence(text);
  } else if (input.sourceType === "pdf" && input.scanPagesB64?.length) {
    // Pre-rasterized segment of a scanned bundle (batch processor path).
    sourceScanPagesB64 = input.scanPagesB64.slice(0, MAX_SCAN_PAGES);
    inputForHash = sourceScanPagesB64.join("");
    user = build.scan(sourceScanPagesB64);
  } else if (input.sourceType === "pdf") {
    if (!input.pdfBase64) {
      throw new DomainError(
        "BAD_UPLOAD",
        "pdfBase64 is required for a pdf source",
        400,
      );
    }
    const buf = decodeBase64Checked(input.pdfBase64, "PDF");
    const text = (await extractPdfText(buf)).trim();
    if (text) {
      sourceText = text;
      inputForHash = text;
      user = build.fence(text);
    } else {
      // No text layer: a scan or a photo-print PDF. Render the pages and use
      // the vision path — the duplicate hash keys on the PDF bytes so the
      // same scan re-uploaded is still caught.
      sourceScanPagesB64 = await rasterizePdfScan(buf);
      inputForHash = buf.toString("base64");
      user = build.scan(sourceScanPagesB64);
    }
  } else {
    if (!input.imageBase64) {
      throw new DomainError(
        "BAD_UPLOAD",
        "imageBase64 is required for an image source",
        400,
      );
    }
    const contentType = input.contentType ?? "image/png";
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new DomainError(
        "BAD_UPLOAD",
        `Unsupported image type '${contentType}'. Use PNG, JPEG, WebP or GIF.`,
        400,
      );
    }
    const buf = decodeBase64Checked(input.imageBase64, "Image");
    sourceImageB64 = buf.toString("base64");
    inputForHash = sourceImageB64;
    user = build.image(contentType, sourceImageB64);
  }

  // Duplicate-document guard: the same content hash on a live or approved
  // case almost always means the same invoice uploaded twice — and two
  // approvals would mean two draft invoices. Failed/rejected duplicates are
  // fine (that's what re-uploading after a fix looks like), and the operator
  // can override deliberately.
  const sourceHash = sha256(inputForHash);
  // Guard + insert in ONE short firm-scoped transaction, committed before the
  // extraction model call: the firm-keyed RLS keeps the duplicate probe
  // tenant-scoped exactly as it was under tenantContext, and committing here
  // means the gateway's ledger rows (raw pool) can reference the case and the
  // stored source survives even if extraction fails mid-flight.
  // The probe is deliberately KIND-AGNOSTIC: the same photo captured once as
  // an invoice and once as a notice is still the same document twice — the
  // second capture should point at the first case, whichever kind it was.
  const created = await inClerkScope(ctx.firmId, async () => {
    if (!input.allowDuplicate) {
      const [dupe] = await getDb()
        .select({ id: clerkCasesTable.id, status: clerkCasesTable.status })
        .from(clerkCasesTable)
        .where(
          and(
            eq(clerkCasesTable.sourceHash, sourceHash),
            notInArray(clerkCasesTable.status, ["failed", "rejected"]),
          ),
        )
        .limit(1);
      if (dupe) {
        throw new DomainError(
          "DUPLICATE_SOURCE",
          `This exact document already has a case (${dupe.id.slice(0, 8)}…, status '${dupe.status}'). Open that case, or resubmit with "create anyway" if this is deliberate.`,
          409,
        );
      }
    }
    const [row] = await getDb()
      .insert(clerkCasesTable)
      .values({
        kind: notice ? "notice" : "extraction",
        status: "pending",
        sourceType: input.sourceType,
        sourceName: input.name ?? null,
        sourceText,
        sourceImageB64,
        sourceScanPagesB64,
        sourceHash,
        dedupeKey: input.allowDuplicate
          ? null
          : `${ctx.firmId ?? "platform"}:${sourceHash}`,
        sourceDurationSec:
          input.sourceType === "voice" ? (input.durationSec ?? null) : null,
        firmId: ctx.firmId ?? null,
        batchId: ctx.batchId ?? null,
        createdBy: actorId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) {
      const [duplicate] = await getDb()
        .select({ id: clerkCasesTable.id, status: clerkCasesTable.status })
        .from(clerkCasesTable)
        .where(
          eq(
            clerkCasesTable.dedupeKey,
            `${ctx.firmId ?? "platform"}:${sourceHash}`,
          ),
        )
        .limit(1);
      throw new DomainError(
        "DUPLICATE_SOURCE",
        duplicate
          ? `This exact document already has a case (${duplicate.id.slice(0, 8)}..., status '${duplicate.status}'). Open that case, or resubmit with "create anyway" if this is deliberate.`
          : "This document conflicts with an existing capture. Refresh and try again.",
        409,
      );
    }
    return row;
  });

  // Supplier memory (text sources with a firm scope): a deterministic match
  // against the firm's own approved fixtures rides along as a one-shot;
  // client-initiated captures narrow the pool to the caller's own cases.
  // Invoice lane only — a notice has no supplier and no fixture pool.
  const exemplar =
    !notice && sourceText && ctx.firmId
      ? await findExtractionExemplar(
          sourceText,
          ctx.firmId,
          ctx.clientScoped ? actorId : null,
        )
      : null;
  const updated = notice
    ? await runNoticeExtraction(
        created.id,
        user,
        inputForHash,
        gateway,
        ctx.firmId ?? null,
      )
    : await runExtraction(
        created.id,
        user,
        inputForHash,
        gateway,
        ctx.firmId ?? null,
        exemplar,
        ctx.clientPartyId ?? null,
      );

  await appendAudit({
    actorId,
    action: "clerk.case.create",
    entityType: "clerk_case",
    entityId: created.id,
    after: {
      kind: notice ? "notice" : "extraction",
      sourceType: input.sourceType,
      status: updated.status,
    },
  });
  return updated;
}

// Per-firm fast-lane threshold attachment (round 7): every listed/fetched
// case carries the confidence threshold in force for ITS firm, so the review
// queue and the bulk-approve re-verify read the same number. Memoized per
// call via a Map keyed by firmId — a 50-row page costs at most a few
// firmFastLaneThreshold lookups, not one per row.
async function attachFastLaneThreshold<T extends { firmId: string | null }>(
  rows: T[],
): Promise<(T & { fastLaneThreshold: number })[]> {
  const byFirm = new Map<string | null, number>();
  const out: (T & { fastLaneThreshold: number })[] = [];
  for (const row of rows) {
    let threshold = byFirm.get(row.firmId);
    if (threshold === undefined) {
      threshold = await firmFastLaneThreshold(row.firmId);
      byFirm.set(row.firmId, threshold);
    }
    out.push({ ...row, fastLaneThreshold: threshold });
  }
  return out;
}

// List omits the bulky/untrusted content columns (sourceImageB64, sourceText,
// sourceScanPagesB64); the detail endpoint returns the row, from which the
// response schema strips the scan pages (server-side retry material only).
export async function listCases(filter: {
  kind?: "extraction" | "question" | "notice";
  status?: ClerkCase["status"];
  limit?: number;
  offset?: number;
  // Route-layer tenancy (Clerk expansion A): firm principals are pinned to
  // their firm (RLS also enforces this at the data layer); a client_user is
  // further narrowed to cases it submitted itself (SEC-03 posture).
  firmId?: string;
  createdBy?: string;
}): Promise<
  (Omit<
    ClerkCase,
    "sourceImageB64" | "sourceText" | "sourceScanPagesB64" | "dedupeKey"
  > & {
    fastLaneThreshold: number;
  })[]
> {
  const conditions = [];
  if (filter.kind) conditions.push(eq(clerkCasesTable.kind, filter.kind));
  if (filter.status) conditions.push(eq(clerkCasesTable.status, filter.status));
  if (filter.firmId) conditions.push(eq(clerkCasesTable.firmId, filter.firmId));
  if (filter.createdBy)
    conditions.push(eq(clerkCasesTable.createdBy, filter.createdBy));
  let builder = getDb()
    .select({
      id: clerkCasesTable.id,
      kind: clerkCasesTable.kind,
      status: clerkCasesTable.status,
      sourceType: clerkCasesTable.sourceType,
      sourceName: clerkCasesTable.sourceName,
      sourceHash: clerkCasesTable.sourceHash,
      sourceDurationSec: clerkCasesTable.sourceDurationSec,
      extraction: clerkCasesTable.extraction,
      noticeExtraction: clerkCasesTable.noticeExtraction,
      preflight: clerkCasesTable.preflight,
      question: clerkCasesTable.question,
      answer: clerkCasesTable.answer,
      feedback: clerkCasesTable.feedback,
      firmId: clerkCasesTable.firmId,
      batchId: clerkCasesTable.batchId,
      claimedBy: clerkCasesTable.claimedBy,
      claimedAt: clerkCasesTable.claimedAt,
      createdBy: clerkCasesTable.createdBy,
      decidedBy: clerkCasesTable.decidedBy,
      decisionAction: clerkCasesTable.decisionAction,
      decisionReason: clerkCasesTable.decisionReason,
      corrections: clerkCasesTable.corrections,
      createdInvoiceId: clerkCasesTable.createdInvoiceId,
      failReason: clerkCasesTable.failReason,
      createdAt: clerkCasesTable.createdAt,
      updatedAt: clerkCasesTable.updatedAt,
    })
    .from(clerkCasesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(clerkCasesTable.createdAt))
    .$dynamic();
  // Absent bounds keep the legacy full-list behaviour for existing clients.
  if (filter.limit !== undefined || filter.offset !== undefined) {
    builder = builder.limit(filter.limit ?? 100).offset(filter.offset ?? 0);
  }
  return attachFastLaneThreshold(await builder);
}

export async function getCase(
  id: string,
): Promise<ClerkCase & { fastLaneThreshold: number }> {
  const [row] = await getDb()
    .select()
    .from(clerkCasesTable)
    .where(eq(clerkCasesTable.id, id))
    .limit(1);
  if (!row)
    throw new DomainError("CASE_NOT_FOUND", "Clerk case not found", 404);
  const [withThreshold] = await attachFastLaneThreshold([row]);
  return withThreshold;
}

// Source pages for the scanned-capture review pane (round 7): the ONLY path
// that returns sourceScanPagesB64 over the API — the scoped carve-out from
// the response schemas' blanket strip. `purged` is an honest marker for the
// review pane: true only when a pdf case's content (scan pages AND any text
// layer) has been retention-cleared in a terminal state — a text-layer pdf
// still holding its text, or a non-pdf case, answers pages [] purged false
// (there were never pages to show, nothing was purged away).
const PURGEABLE_STATUSES: ReadonlySet<ClerkCase["status"]> = new Set([
  "approved",
  "rejected",
  "failed",
]);

export function caseSourcePages(row: ClerkCase): {
  pages: string[];
  purged: boolean;
} {
  const pages = row.sourceScanPagesB64 ?? [];
  const purged =
    pages.length === 0 &&
    row.sourceType === "pdf" &&
    row.sourceText == null &&
    PURGEABLE_STATUSES.has(row.status);
  return { pages, purged };
}

// The asker's helpfulness signal on a question case (round 7 review
// integrity). Creator-only for EVERY role — the rating is the asker's own
// signal, so even an operator or a firm admin cannot rate someone else's
// question — with the same 404 non-disclosure as the case-detail route for
// both the tenant mismatch and the non-creator case. Refusals are ratable
// (an unhelpful refusal is exactly the signal the ask-feedback report
// mines); re-rating overwrites (the asker changed their mind).
export async function setCaseFeedback(
  caseId: string,
  principalUserId: string,
  tenant: string | null,
  helpful: boolean,
): Promise<void> {
  const existing = await getCase(caseId);
  if (
    (tenant && existing.firmId !== tenant) ||
    existing.createdBy !== principalUserId
  ) {
    throw new DomainError("CASE_NOT_FOUND", "Clerk case not found", 404);
  }
  if (existing.kind !== "question") {
    throw new DomainError(
      "NOT_A_QUESTION",
      "Only question cases take helpfulness feedback",
      409,
    );
  }
  await getDb()
    .update(clerkCasesTable)
    .set({ feedback: helpful ? "helpful" : "not_helpful" })
    .where(eq(clerkCasesTable.id, caseId));
}

// RLS on the firm data is bypassed for operators, so firm membership of the
// chosen parties is validated explicitly: a party belongs to a firm when it is
// a client of one of the firm's engagements, already appears on one of the
// firm's invoices, or was created BY the firm (created_by_firm_id provenance —
// the party-sphere arm). The provenance arm is what lets the FIRST bill from a
// freshly created vendor party approve: a brand-new vendor has no engagement
// and, by definition, no invoice yet.
export async function assertPartyInFirm(
  firmId: string,
  partyId: string,
  label: string,
) {
  const [viaEngagement] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, partyId),
      ),
    )
    .limit(1);
  if (viaEngagement) return;
  const [viaInvoice] = await getDb()
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        or(
          eq(invoicesTable.supplierPartyId, partyId),
          eq(invoicesTable.buyerPartyId, partyId),
        ),
      ),
    )
    .limit(1);
  if (viaInvoice) return;
  const [viaProvenance] = await getDb()
    .select({ id: partiesTable.id })
    .from(partiesTable)
    .where(
      and(
        eq(partiesTable.id, partyId),
        eq(partiesTable.createdByFirmId, firmId),
      ),
    )
    .limit(1);
  if (viaProvenance) return;
  throw new DomainError(
    "PARTY_NOT_IN_FIRM",
    `The chosen ${label} party is not linked to the chosen firm (no engagement, invoice or party record created by the firm references it)`,
    400,
  );
}

// One operator actively works a case at a time. Claiming is a compare-and-set
// on (status = extracted, unclaimed) so two operators cannot both win, and the
// claim timestamp splits decision turnaround into queue-wait and active-review
// time (CLK-OPS-06).
export async function claimCase(
  id: string,
  actorId: string,
): Promise<ClerkCase> {
  const existing = await getCase(id);
  const [row] = await getDb()
    .update(clerkCasesTable)
    .set({ status: "in_review", claimedBy: actorId, claimedAt: new Date() })
    .where(
      and(
        eq(clerkCasesTable.id, id),
        eq(clerkCasesTable.status, "extracted"),
        isNull(clerkCasesTable.claimedBy),
      ),
    )
    .returning();
  if (!row) {
    throw new DomainError(
      "CASE_CLAIM_CONFLICT",
      existing.claimedBy
        ? "Another operator has already claimed this case"
        : `A '${existing.status}' case cannot be claimed`,
      409,
    );
  }
  await appendAudit({
    actorId,
    action: "clerk.case.claim",
    entityType: "clerk_case",
    entityId: id,
    after: { claimedBy: actorId },
  });
  return row;
}

// Any operator may release a stuck claim (small-team reality: the holder may
// be gone); the audit row records who did it.
export async function releaseCase(
  id: string,
  actorId: string,
): Promise<ClerkCase> {
  const [row] = await getDb()
    .update(clerkCasesTable)
    .set({ status: "extracted", claimedBy: null, claimedAt: null })
    .where(
      and(eq(clerkCasesTable.id, id), eq(clerkCasesTable.status, "in_review")),
    )
    .returning();
  if (!row) {
    const existing = await getCase(id);
    throw new DomainError(
      "CASE_BAD_STATE",
      `A '${existing.status}' case cannot be released`,
      409,
    );
  }
  await appendAudit({
    actorId,
    action: "clerk.case.release",
    entityType: "clerk_case",
    entityId: id,
  });
  return row;
}
