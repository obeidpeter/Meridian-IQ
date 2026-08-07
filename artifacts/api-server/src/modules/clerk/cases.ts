import { Buffer } from "node:buffer";
import { and, asc, desc, eq, inArray, isNull, notInArray, or } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  engagementsTable,
  invoicesTable,
  firmsTable,
  membershipsTable,
  obligationsTable,
  partiesTable,
  type ClerkCase,
  type ClerkNoticeExtraction,
  type ExtractionField,
  type ExtractionLine,
  type Obligation,
} from "@workspace/db";
import { DomainError } from "../errors";
import { isUniqueViolation } from "../../lib/pg-errors";
import { appendAudit } from "../audit/audit";
import { createDraft, type LineInput } from "../invoice/service";
import {
  computeCorrections,
  computeLineCorrections,
  computeNoticeCorrections,
} from "./corrections";
import {
  assertClerkEnabled,
  sha256,
  type ClerkGateway,
  type InferResult,
  type UserContent,
} from "./gateway";
import {
  transcribeAndLedger,
  transcribeVoiceProd,
  type VoiceTranscriber,
} from "./provider";
import {
  CANONICAL_FIELDS,
  CRITICAL_FIELDS,
  EXTRACT_JSON_SCHEMA,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_EXEMPLAR_PROMPT_VERSION,
  EXTRACT_SYSTEM,
  EXEMPLAR_SYSTEM_SUFFIX,
  FLAG_CONFIDENCE_THRESHOLD,
  docImageUserContent,
  docScanUserContent,
  exemplarSection,
  extractionOutputSchema,
  fenceUntrusted,
  type ExtractionOutput,
} from "./prompts";
import {
  EXTRACT_NOTICE_JSON_SCHEMA,
  EXTRACT_NOTICE_PROMPT_VERSION,
  EXTRACT_NOTICE_SYSTEM,
  NOTICE_CRITICAL_FIELDS,
  NOTICE_FIELDS,
  isIsoDate as isIsoNoticeDate,
  noticeOutputSchema,
  noticePreflightChecks,
  type NoticeAuthority,
  type NoticeExtractionOutput,
  type NoticeTaxType,
  type NoticeType,
} from "./notice-prompts";
import { preflightChecks } from "./preflight";
import { registerPreflightChecks } from "./register-preflight";
import { findExtractionExemplar, type ExtractionExemplar } from "./exemplar";
import { recordPartyAliases } from "./alias";
import { firmFastLaneThreshold } from "./metrics";
import { inClerkScope } from "./scope";

// Clerk capture cases (Task #40, C1). The Clerk PROPOSES, the operator
// DISPOSES: extraction output is candidate values only; nothing reaches the
// invoice spine until a named operator confirms every critical field and
// approves — and even then only a DRAFT invoice is created. There is no code
// path from this module to invoice submission.

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // decoded

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

export function decodeBase64Checked(b64: string, label: string): Buffer {
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, "base64");
  } catch {
    throw new DomainError("BAD_UPLOAD", `${label} is not valid base64`, 400);
  }
  if (buf.length === 0) {
    throw new DomainError("BAD_UPLOAD", `${label} is empty`, 400);
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      `${label} exceeds the 5 MB upload limit`,
      413,
    );
  }
  return buf;
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    // pageJoiner "" disables pdf-parse's "-- N of M --" page markers; without
    // this a textless scan still "has text" (the markers) and the no-text
    // detection that routes scans to the vision path can never fire.
    const result = await parser.getText({ pageJoiner: "" });
    return result.text ?? "";
  } catch {
    throw new DomainError(
      "PDF_UNREADABLE",
      "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
      422,
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// Scanned-PDF intake (Clerk idea #1). Most real Nigerian SME documents are
// scans and phone-photo PDFs with no text layer; instead of rejecting them,
// render the pages to images (pdf-parse's pdfjs + @napi-rs/canvas stack —
// already in the tree for text extraction) and run them through the SAME
// vision extraction as an image upload: same gateway, ledger, budget,
// duplicate guard and human review.
//
// One capture is ONE invoice, so the page cap is deliberately small: it
// bounds vision-token cost per call and keeps multi-invoice bundles on the
// batch path where segmentation belongs.
export const MAX_SCAN_PAGES = 4;
const SCAN_RENDER_WIDTH = 1600;

export async function rasterizePdfScan(buf: Buffer): Promise<string[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const shot = await parser.getScreenshot({
      first: MAX_SCAN_PAGES,
      desiredWidth: SCAN_RENDER_WIDTH,
    });
    if (shot.total > MAX_SCAN_PAGES) {
      throw new DomainError(
        "SCAN_TOO_LONG",
        `This scan has ${shot.total} pages; a single capture takes at most ${MAX_SCAN_PAGES}. Upload just the invoice's pages, or split the document.`,
        422,
      );
    }
    const pages = shot.pages
      .map((p) => p.dataUrl?.replace(/^data:image\/png;base64,/, "") ?? "")
      .filter((p) => p.length > 0);
    if (pages.length === 0) {
      throw new DomainError(
        "PDF_UNREADABLE",
        "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
        422,
      );
    }
    return pages;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError(
      "PDF_UNREADABLE",
      "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
      422,
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// The vision-extraction counterpart of fenceDocument for a multi-page scan:
// the shared anti-injection scan builder (prompts.ts) with the invoice noun.
export function scanUserContent(pagesB64: string[]): UserContent {
  return docScanUserContent("The invoice", pagesB64);
}

// Shared text/pdf intake validation for single-case and batch intake: the
// upload guards, decode/extract pipeline and error strings live here so the
// two paths cannot drift. Only the PDF_NO_TEXT advice sentence differs per
// caller.
export async function resolveTextSource(
  sourceType: "text" | "pdf",
  input: { text?: string; pdfBase64?: string },
  pdfNoTextAdvice: string,
): Promise<string> {
  if (sourceType === "text") {
    if (!input.text?.trim()) {
      throw new DomainError("BAD_UPLOAD", "text is required for a text source", 400);
    }
    return input.text; // NOT trimmed — trimming would change the stored sourceText and the duplicate-detection hash
  }
  if (!input.pdfBase64) {
    throw new DomainError("BAD_UPLOAD", "pdfBase64 is required for a pdf source", 400);
  }
  const buf = decodeBase64Checked(input.pdfBase64, "PDF");
  const text = (await extractPdfText(buf)).trim();
  if (!text) {
    throw new DomainError(
      "PDF_NO_TEXT",
      `The PDF contains no selectable text (it is probably a scan). ${pdfNoTextAdvice}`,
      422,
    );
  }
  return text;
}

// Normalize raw model output into exactly one candidate per canonical field,
// with deterministic critical/flagged marking. Critical fields are ALWAYS
// flagged for human confirmation regardless of the model's confidence.
export function normalizeExtraction(output: ExtractionOutput): {
  fields: ExtractionField[];
  lines: ExtractionLine[];
} {
  const byField = new Map(output.fields.map((f) => [f.field, f]));
  const fields: ExtractionField[] = CANONICAL_FIELDS.map((field) => {
    const raw = byField.get(field);
    const value = raw?.value ?? null;
    const confidence = raw ? Math.max(0, Math.min(1, raw.confidence)) : 0;
    const critical = CRITICAL_FIELDS.has(field);
    return {
      field,
      value,
      confidence,
      sourceSnippet: raw?.sourceSnippet ?? null,
      critical,
      flagged:
        critical || value === null || confidence < FLAG_CONFIDENCE_THRESHOLD,
    };
  });
  return { fields, lines: output.lines };
}

// The persist-outcome skeleton BOTH extraction lanes (invoice and notice)
// share. On success the lane's callback builds the columns to store (its
// proposal column plus the recomputed preflight) and the case flips to
// "extracted" with failReason cleared; the callback is awaited BEFORE the
// short update transaction so lane work that needs the firm's data (the
// invoice lane's register-history preflight) runs outside it, exactly as
// before. The fail-closed arm lives here ONCE so the lanes can never drift:
// invalid model output is DISCARDED (never shown) and the case is escalated
// to a human; provider errors mark the case failed.
async function persistExtractionOutcome<T>(
  caseId: string,
  firmId: string | null,
  result: InferResult<T>,
  buildSuccessSet: (data: T) => Promise<Partial<ClerkCase>>,
): Promise<ClerkCase> {
  if (result.ok) {
    const set = await buildSuccessSet(result.data);
    const [updated] = await inClerkScope(firmId, () =>
      getDb()
        .update(clerkCasesTable)
        .set({
          status: "extracted",
          failReason: null,
          ...set,
        })
        .where(eq(clerkCasesTable.id, caseId))
        .returning(),
    );
    return updated;
  }
  // Fail closed: invalid model output is DISCARDED (never shown) and the
  // case is escalated to a human; provider errors mark the case failed.
  const [updated] = await inClerkScope(firmId, () =>
    getDb()
      .update(clerkCasesTable)
      .set({
        status: result.outcome === "invalid_discarded" ? "escalated" : "failed",
        failReason: result.message,
      })
      .where(eq(clerkCasesTable.id, caseId))
      .returning(),
  );
  return updated;
}

// The model call + case update shared by first-time intake and retries.
// `exemplar` is the supplier-memory one-shot (exemplar.ts) — text sources
// only, same-firm only, selected deterministically by the caller.
async function runExtraction(
  caseId: string,
  user: UserContent,
  inputForHash: string,
  gateway: ClerkGateway,
  firmId: string | null = null,
  exemplar: ExtractionExemplar | null = null,
  // SEC-03: the capturing client's own party for a client_user capture, so the
  // register-history checks never leak a sibling client's ledger. Null for
  // firm/operator captures (full firm-wide view).
  capturingClientPartyId: string | null = null,
): Promise<ClerkCase> {
  // The exemplar variant carries its own prompt version so ledger cohorts
  // can compare corrected-rates with and without supplier memory.
  const withExemplar = exemplar !== null && typeof user === "string";
  const result = await gateway.infer<ExtractionOutput>({
    purpose: "extract_invoice",
    caseId,
    firmId,
    promptVersion: withExemplar
      ? EXTRACT_EXEMPLAR_PROMPT_VERSION
      : EXTRACT_PROMPT_VERSION,
    system: withExemplar
      ? EXTRACT_SYSTEM + EXEMPLAR_SYSTEM_SUFFIX
      : EXTRACT_SYSTEM,
    user: withExemplar
      ? `${exemplarSection(exemplar)}\n\n${user as string}`
      : user,
    schemaName: "invoice_extraction",
    jsonSchema: EXTRACT_JSON_SCHEMA,
    validator: extractionOutputSchema,
    inputForHash,
  });

  return persistExtractionOutcome(caseId, firmId, result, async (data) => {
    const normalized = normalizeExtraction(data);
    const extraction = {
      fields: normalized.fields,
      lines: normalized.lines,
      promptVersion: withExemplar
        ? EXTRACT_EXEMPLAR_PROMPT_VERSION
        : EXTRACT_PROMPT_VERSION,
      model: gateway.model,
      // Auditability: which approved case's exemplar rode along.
      ...(withExemplar ? { exemplarCaseId: exemplar.caseId } : {}),
    };
    // Deterministic pre-approval checks, recomputed on every successful
    // (re-)extraction; an empty list marks the case ready for the review fast
    // lane. Register-history checks need the firm's data, so they run here —
    // OUTSIDE the short update transaction — then merge into the same
    // preflight list the console already renders.
    const preflight = [
      ...preflightChecks(extraction),
      ...(await registerPreflightChecks(
        extraction,
        firmId,
        capturingClientPartyId,
      )),
    ];
    return { extraction, preflight };
  });
}

// Normalize raw notice-model output into exactly one candidate per canonical
// notice field. Unlike the invoice lane (where critical fields are ALWAYS
// flagged), a notice case NEVER fast-lanes — every one gets human eyes — so
// `flagged` highlights only the critical fields that actually need attention:
// missing, or below the shared confidence bar.
export function normalizeNoticeExtraction(
  output: NoticeExtractionOutput,
): ExtractionField[] {
  const byField = new Map(output.fields.map((f) => [f.field, f]));
  return NOTICE_FIELDS.map((field) => {
    const raw = byField.get(field);
    const value = raw?.value ?? null;
    const confidence = raw ? Math.max(0, Math.min(1, raw.confidence)) : 0;
    const critical = NOTICE_CRITICAL_FIELDS.has(field);
    return {
      field,
      value,
      confidence,
      sourceSnippet: raw?.sourceSnippet ?? null,
      critical,
      flagged:
        critical && (value === null || confidence < FLAG_CONFIDENCE_THRESHOLD),
    };
  });
}

// The notice lane's runExtraction twin: same gateway discipline (purpose in
// the ledger, schema-validated output), same fail-closed handling via the
// shared persistExtractionOutcome skeleton (invalid output → escalated to a
// human, provider error → failed with a stored reason). No exemplar and no
// register-history preflight — both are invoice machinery; the notice
// preflight is the pure notice-prompts.ts check set.
async function runNoticeExtraction(
  caseId: string,
  user: UserContent,
  inputForHash: string,
  gateway: ClerkGateway,
  firmId: string | null = null,
): Promise<ClerkCase> {
  const result = await gateway.infer<NoticeExtractionOutput>({
    purpose: "extract_notice",
    caseId,
    firmId,
    promptVersion: EXTRACT_NOTICE_PROMPT_VERSION,
    system: EXTRACT_NOTICE_SYSTEM,
    user,
    schemaName: "notice_extraction",
    jsonSchema: EXTRACT_NOTICE_JSON_SCHEMA,
    validator: noticeOutputSchema,
    inputForHash,
  });

  return persistExtractionOutcome(caseId, firmId, result, async (data) => {
    const noticeExtraction: ClerkNoticeExtraction = {
      fields: normalizeNoticeExtraction(data),
      noticeType: data.noticeType,
      promptVersion: EXTRACT_NOTICE_PROMPT_VERSION,
      model: gateway.model,
    };
    return { noticeExtraction, preflight: noticePreflightChecks(noticeExtraction) };
  });
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
    ? await runNoticeExtraction(id, user, inputForHash, gateway, existing.firmId)
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
      throw new DomainError("BAD_UPLOAD", "pdfBase64 is required for a pdf source", 400);
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
      throw new DomainError("BAD_UPLOAD", "imageBase64 is required for an image source", 400);
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
        sourceDurationSec:
          input.sourceType === "voice" ? (input.durationSec ?? null) : null,
        firmId: ctx.firmId ?? null,
        batchId: ctx.batchId ?? null,
        createdBy: actorId,
      })
      .returning();
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

export function fenceDocument(text: string): string {
  return fenceUntrusted("invoice document content", "DOCUMENT", text);
}

// The notice lane's fence/user-content builders — the same anti-injection
// shapes as the invoice trio below, with the document noun corrected so the
// prompt never calls a notice an invoice. Shared by first-time intake and
// retries (retryExtraction re-fences with the case's own kind).
export function fenceNoticeDocument(text: string): string {
  return fenceUntrusted("tax-authority notice content", "NOTICE DOCUMENT", text);
}

export function noticeImageUserContent(
  contentType: string,
  b64: string,
): UserContent {
  return docImageUserContent("The tax-authority notice", contentType, b64);
}

export function noticeScanUserContent(pagesB64: string[]): UserContent {
  return docScanUserContent("The tax-authority notice", pagesB64);
}

// The image counterpart of fenceDocument: the shared anti-injection image
// builder (prompts.ts) with the invoice noun. Shared by first-time intake and
// retries so the injection-hardening text for images is maintained in one
// place.
export function imageUserContent(contentType: string, b64: string): UserContent {
  return docImageUserContent("The invoice", contentType, b64);
}

// One lane-dispatch table per document kind. Retry and first-time intake
// select the lane ONCE and share these records — the notice/invoice builder
// pick is never re-decided per source branch — so the "same wording as
// first-time intake" guarantee on retry is structural: a new source type (or
// documentKind) cannot silently drift one path.
const INVOICE_CONTENT_BUILDERS = {
  fence: fenceDocument,
  image: imageUserContent,
  scan: scanUserContent,
} as const;
const NOTICE_CONTENT_BUILDERS = {
  fence: fenceNoticeDocument,
  image: noticeImageUserContent,
  scan: noticeScanUserContent,
} as const;

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
  (Omit<ClerkCase, "sourceImageB64" | "sourceText" | "sourceScanPagesB64"> & {
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
  if (!row) throw new DomainError("CASE_NOT_FOUND", "Clerk case not found", 404);
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
async function assertPartyInFirm(firmId: string, partyId: string, label: string) {
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
export async function claimCase(id: string, actorId: string): Promise<ClerkCase> {
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
export async function releaseCase(id: string, actorId: string): Promise<ClerkCase> {
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
