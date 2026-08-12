import { eq } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  type ClerkCase,
  type ClerkNoticeExtraction,
  type ExtractionField,
  type ExtractionLine,
} from "@workspace/db";
import {
  type ClerkGateway,
  type InferResult,
  type UserContent,
} from "../gateway";
import {
  CANONICAL_FIELDS,
  CRITICAL_FIELDS,
  EXTRACT_JSON_SCHEMA,
  EXTRACT_PROMPT_VERSION,
  EXTRACT_EXEMPLAR_PROMPT_VERSION,
  EXTRACT_SYSTEM,
  EXEMPLAR_SYSTEM_SUFFIX,
  FLAG_CONFIDENCE_THRESHOLD,
  exemplarSection,
  extractionOutputSchema,
  type ExtractionOutput,
} from "../prompts";
import {
  EXTRACT_NOTICE_JSON_SCHEMA,
  EXTRACT_NOTICE_PROMPT_VERSION,
  EXTRACT_NOTICE_SYSTEM,
  NOTICE_CRITICAL_FIELDS,
  NOTICE_FIELDS,
  noticeOutputSchema,
  noticePreflightChecks,
  type NoticeExtractionOutput,
} from "../notice-prompts";
import { preflightChecks } from "../preflight";
import { registerPreflightChecks } from "../register-preflight";
import { type ExtractionExemplar } from "../exemplar";
import { inClerkScope } from "../scope";

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
export async function runExtraction(
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
export async function runNoticeExtraction(
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
    return {
      noticeExtraction,
      preflight: noticePreflightChecks(noticeExtraction),
    };
  });
}
