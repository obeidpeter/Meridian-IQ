import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  getDb,
  clerkInferenceRunsTable,
  clerkKillSwitchesTable,
  type ClerkKillSwitchRow,
} from "@workspace/db";

// The single MeridianIQ inference gateway (CLK-AI-01): every OCR/ASR/model
// call routes through here — production code contains no unmanaged provider
// endpoint. v1 ships one provider: a deterministic synthetic extractor that
// exercises the full control surface (typed outputs, confidence routing,
// kill switches, provenance) on text sources. A real Nigeria-resident model
// slots in behind the same seam once OPEN-6/OPEN-11 close (CLK-SEC-02 keeps
// real-client inference blocked until then).

export const POLICY_VERSION = "clerk-policy-v1";
export const EXTRACTOR_VERSION = "synthetic-extractor-v1";

// Critical invoice fields (Supplemental Appendix B): these never bypass human
// confirmation regardless of confidence (CLK-CAP-06).
export const CRITICAL_FIELDS = new Set([
  "buyerName",
  "buyerTin",
  "invoiceNumber",
  "issueDate",
  "currency",
  "grandTotal",
  "vatAmount",
]);

// Below this, a field routes to clarification instead of silent acceptance
// (CLK-AI-05 risk- and field-specific confidence routing).
export const CONFIDENCE_THRESHOLD = 0.75;

export type ClerkCapability =
  | "extraction"
  | "answers"
  | "explanation";

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

// Kill switches (CLK-AI-11): global and per-capability, stored in the
// database so an incident commander can flip them without a deployment.
// A missing row means enabled; flipping upserts.
export async function checkKillSwitches(
  capability: ClerkCapability,
): Promise<GateDecision> {
  const rows = await getDb().select().from(clerkKillSwitchesTable);
  const byKey = new Map(rows.map((r) => [r.capability, r]));
  const global = byKey.get("global");
  if (global?.disabled) {
    return {
      allowed: false,
      reason: global.reason ?? "Clerk is disabled by the global kill switch",
    };
  }
  const specific = byKey.get(capability);
  if (specific?.disabled) {
    return {
      allowed: false,
      reason:
        specific.reason ?? `Clerk ${capability} is disabled by kill switch`,
    };
  }
  return { allowed: true };
}

export async function listKillSwitches(): Promise<ClerkKillSwitchRow[]> {
  const rows = await getDb().select().from(clerkKillSwitchesTable);
  const byKey = new Map(rows.map((r) => [r.capability, r]));
  // Present the full switch set even before any row exists.
  const all: ClerkKillSwitchRow[] = [];
  for (const capability of ["global", "extraction", "answers", "explanation"]) {
    all.push(
      byKey.get(capability) ?? {
        capability,
        disabled: false,
        reason: null,
        changedBy: null,
        changedAt: new Date(0),
      },
    );
  }
  return all;
}

export async function setKillSwitch(
  capability: string,
  disabled: boolean,
  reason: string | null,
  changedBy: string,
): Promise<ClerkKillSwitchRow> {
  const [row] = await getDb()
    .insert(clerkKillSwitchesTable)
    .values({ capability, disabled, reason, changedBy, changedAt: new Date() })
    .onConflictDoUpdate({
      target: clerkKillSwitchesTable.capability,
      set: { disabled, reason, changedBy, changedAt: new Date() },
    })
    .returning();
  return row;
}

// ---------------------------------------------------------------------------
// Inference execution with full provenance (CLK-OBS-02, CLK-AI-02/07)
// ---------------------------------------------------------------------------

export interface InferenceRequest<T> {
  firmId: string | null;
  caseId?: string | null;
  purpose: "extraction" | "intent" | "answer" | "explanation";
  model: string;
  promptVersion: string;
  input: string;
  // The provider itself — a pure function in v1. Typed output only
  // (CLK-AI-02): whatever it returns is validated by the caller's parse.
  run: (input: string) => { output: T; confidence: number | null };
}

export interface InferenceResult<T> {
  outcome: "allowed" | "blocked" | "error";
  output: T | null;
  confidence: number | null;
  blockedReason?: string;
}

function hashInput(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// Run a provider call through the gateway: kill-switch check first, full
// provenance row always — including blocked and failed calls, because an
// auditor must see what was attempted, not only what succeeded.
export async function runInference<T extends Record<string, unknown>>(
  req: InferenceRequest<T>,
): Promise<InferenceResult<T>> {
  const capability: ClerkCapability =
    req.purpose === "extraction"
      ? "extraction"
      : req.purpose === "explanation"
        ? "explanation"
        : "answers";
  const gate = await checkKillSwitches(capability);
  const startedAt = Date.now();
  if (!gate.allowed) {
    await getDb().insert(clerkInferenceRunsTable).values({
      firmId: req.firmId,
      caseId: req.caseId ?? null,
      purpose: req.purpose,
      model: req.model,
      promptVersion: req.promptVersion,
      policyVersion: POLICY_VERSION,
      inputHash: hashInput(req.input),
      typedOutput: null,
      outcome: "blocked",
      confidence: null,
      latencyMs: 0,
    });
    return {
      outcome: "blocked",
      output: null,
      confidence: null,
      blockedReason: gate.reason,
    };
  }
  try {
    const { output, confidence } = req.run(req.input);
    await getDb().insert(clerkInferenceRunsTable).values({
      firmId: req.firmId,
      caseId: req.caseId ?? null,
      purpose: req.purpose,
      model: req.model,
      promptVersion: req.promptVersion,
      policyVersion: POLICY_VERSION,
      inputHash: hashInput(req.input),
      typedOutput: output,
      outcome: "allowed",
      confidence: confidence === null ? null : confidence.toFixed(3),
      latencyMs: Date.now() - startedAt,
    });
    return { outcome: "allowed", output, confidence };
  } catch {
    // Schema-invalid or provider failure: discarded, never shown (CLK-AI-02).
    await getDb().insert(clerkInferenceRunsTable).values({
      firmId: req.firmId,
      caseId: req.caseId ?? null,
      purpose: req.purpose,
      model: req.model,
      promptVersion: req.promptVersion,
      policyVersion: POLICY_VERSION,
      inputHash: hashInput(req.input),
      typedOutput: null,
      outcome: "error",
      confidence: null,
      latencyMs: Date.now() - startedAt,
    });
    return { outcome: "error", output: null, confidence: null };
  }
}

// Record a deterministic refusal with the same provenance discipline.
export async function recordRefusal(input: {
  firmId: string | null;
  caseId?: string | null;
  purpose: "intent" | "answer" | "explanation";
  model: string;
  promptVersion: string;
  input: string;
  reason: string;
}): Promise<void> {
  await getDb().insert(clerkInferenceRunsTable).values({
    firmId: input.firmId,
    caseId: input.caseId ?? null,
    purpose: input.purpose,
    model: input.model,
    promptVersion: input.promptVersion,
    policyVersion: POLICY_VERSION,
    inputHash: hashInput(input.input),
    typedOutput: { refusalReason: input.reason },
    outcome: "refused",
    confidence: null,
    latencyMs: 0,
  });
}

export async function listRunsForCase(caseId: string) {
  return getDb()
    .select()
    .from(clerkInferenceRunsTable)
    .where(eq(clerkInferenceRunsTable.caseId, caseId));
}

// ---------------------------------------------------------------------------
// Synthetic deterministic extractor (the v1 "provider")
// ---------------------------------------------------------------------------
//
// Regex/heuristic extraction of canonical invoice fields from free text. It is
// intentionally modest: the point of C0/C1 is proving the control surface —
// candidates, confidence routing, critical-field confirmation, provenance —
// not extraction quality. Because it is pure pattern matching, document text
// can never act as an instruction to it (CLK-CAP-05 holds by construction).

export interface ExtractedField extends Record<string, unknown> {
  fieldKey: string;
  value: string;
  confidence: number;
  line: number;
  start: number;
  end: number;
}

export interface ExtractionOutput extends Record<string, unknown> {
  fields: ExtractedField[];
}

interface Matcher {
  fieldKey: string;
  // Labelled matches are high confidence; bare pattern matches are lower.
  labelled: RegExp;
  bare?: RegExp;
  normalize?: (raw: string) => string;
}

const AMOUNT = String.raw`(?:NGN|₦|N)?\s*([\d,]+(?:\.\d{1,2})?)`;

const MATCHERS: Matcher[] = [
  {
    fieldKey: "invoiceNumber",
    labelled: /(?:invoice\s*(?:no|number|#)|inv\.?\s*(?:no|#))[:.\s]*([A-Z0-9][A-Z0-9/-]{2,})/i,
    bare: /\b(INV[-/][A-Z0-9-]{2,})\b/i,
  },
  {
    fieldKey: "issueDate",
    labelled: /(?:date|issued(?:\s*on)?|invoice\s*date)[:.\s]*(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
    bare: /\b(\d{4}-\d{2}-\d{2})\b/,
    normalize: (raw) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      const m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
      if (!m) return raw;
      const [, d, mo, y] = m;
      const year = y.length === 2 ? `20${y}` : y;
      return `${year}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    },
  },
  {
    fieldKey: "buyerName",
    labelled: /(?:bill(?:ed)?\s*to|buyer|customer|sold\s*to|to)[:.\s]+([A-Z][\w&.' -]{2,60})/i,
  },
  {
    fieldKey: "buyerTin",
    labelled: /(?:tin|tax\s*id(?:entification)?(?:\s*number)?)[:.\s]*(\d[\d-]{7,})/i,
    normalize: (raw) => raw.replace(/-/g, ""),
  },
  {
    fieldKey: "grandTotal",
    labelled: new RegExp(
      String.raw`(?:grand\s*total|total\s*(?:due|amount)?)[:.\s]*${AMOUNT}`,
      "i",
    ),
    normalize: (raw) => raw.replace(/,/g, ""),
  },
  {
    fieldKey: "vatAmount",
    labelled: new RegExp(String.raw`vat(?:\s*\(?[\d.]*%?\)?)?[:.\s]*${AMOUNT}`, "i"),
    normalize: (raw) => raw.replace(/,/g, ""),
  },
  {
    fieldKey: "currency",
    labelled: /\b(NGN|USD|EUR|GBP)\b/,
  },
];

export function extractInvoiceFields(text: string): {
  output: ExtractionOutput;
  confidence: number | null;
} {
  const lines = text.split(/\r?\n/);
  const fields: ExtractedField[] = [];
  const seen = new Set<string>();

  for (const matcher of MATCHERS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let match = matcher.labelled.exec(line);
      let confidence = 0.9;
      if (!match && matcher.bare) {
        match = matcher.bare.exec(line);
        confidence = 0.6;
      }
      if (!match || match[1] === undefined) continue;
      if (seen.has(matcher.fieldKey)) continue;
      seen.add(matcher.fieldKey);
      const raw = match[1].trim();
      fields.push({
        fieldKey: matcher.fieldKey,
        value: matcher.normalize ? matcher.normalize(raw) : raw,
        confidence,
        line: i + 1,
        start: match.index,
        end: match.index + match[0].length,
      });
      break;
    }
  }

  // A naira symbol anywhere implies NGN even without an explicit code.
  if (!seen.has("currency") && /₦/.test(text)) {
    fields.push({
      fieldKey: "currency",
      value: "NGN",
      confidence: 0.8,
      line: 1,
      start: 0,
      end: 0,
    });
  }

  const avg =
    fields.length > 0
      ? fields.reduce((s, f) => s + f.confidence, 0) / fields.length
      : null;
  return { output: { fields }, confidence: avg };
}

// Basic secret/credential detection on inbound sources (CLK-SEC-08).
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:password|passwd|pwd)\s*[:=]\s*\S{6,}/i,
  /\bBearer\s+[A-Za-z0-9._-]{20,}\b/,
];

export function containsSecretMaterial(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text));
}
