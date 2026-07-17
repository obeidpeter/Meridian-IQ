// Pure helpers shared across the Clerk pages (clerk.tsx, clerk-claims.tsx,
// clerk-health.tsx): status tones, the fast-lane predicate, intake-source
// presentation, the approval form's VAT normalisation, and the shared toast
// payloads. No hooks and no JSX live here, so the module is directly
// unit-testable (clerk-shared.test.ts).
import type {
  ClerkCase,
  ClerkCaseDecisionInputCategory,
  InvoiceLineInput,
} from "@workspace/api-client-react";
import type { LucideIcon } from "lucide-react";
import { FileText, MessageSquareText, Mic, ScanLine } from "lucide-react";
import type { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import type { BadgeTone } from "@/lib/format";

// Clerk case status tones, shared by the capture queue (clerk.tsx) and the
// Health tab's cases-by-status breakdown (clerk-health.tsx).
export const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "slate",
  extracted: "blue",
  in_review: "amber",
  approved: "emerald",
  rejected: "red",
  escalated: "amber",
  failed: "red",
};

// Fast-lane predicate for the intake queue: a case is "ready to approve" when
// extraction succeeded, the server's deterministic pre-flight found nothing
// BLOCKING (advisory issues — e.g. "the register knows a TIN this document
// doesn't print" — inform the reviewer without costing the fast lane; a
// null/undefined list means pre-flight never ran, which is not the same as
// clear), and every critical field arrived with a value at high confidence.
// Purely a triage hint: approval still needs the operator's eyes.
export function isReadyToApprove(kase: ClerkCase): boolean {
  if (kase.status !== "extracted") return false;
  if (!Array.isArray(kase.preflight)) return false;
  if (kase.preflight.some((i) => i.severity !== "advisory")) return false;
  return (kase.extraction?.fields ?? []).every(
    (f) => !f.critical || (f.value != null && f.confidence >= 0.9),
  );
}

// Evidence weights from the corrections exhaust (metrics.corrections):
// fields operators historically correct often demand more attention than
// fields they always keep. A field below the sample floor carries weight 1 —
// no evidence, no bias. Line fields are excluded (positional pairing makes
// their attribution unreliable, same reasoning as calibration).
export interface FieldCorrectionStat {
  field: string;
  total: number;
  overrideRate: number;
}

const WEIGHT_MIN_SAMPLES = 20;

export function fieldWeights(
  stats: FieldCorrectionStat[] | undefined,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const s of stats ?? []) {
    if (s.total >= WEIGHT_MIN_SAMPLES && !s.field.startsWith("lines.")) {
      weights.set(s.field, 1 + Math.min(1, Math.max(0, s.overrideRate)));
    }
  }
  return weights;
}

// The display floor for the review pane's "historically corrected" hint —
// stricter than the weighting floor because a visible warning label needs
// more evidence than a subtle ordering nudge.
export function correctionHint(
  field: string,
  stats: FieldCorrectionStat[] | undefined,
): string | null {
  const s = (stats ?? []).find((x) => x.field === field);
  if (!s || s.total < WEIGHT_MIN_SAMPLES || s.overrideRate < 0.15) return null;
  return `corrected in ${Math.round(s.overrideRate * 100)}% of past cases`;
}

// Expected review effort for queue ordering: flagged fields plus pre-flight
// findings are exactly the items an operator must look at before deciding.
// Lighter cases surface first within the non-fast-lane group, so the queue
// drains by throughput instead of strict arrival order. With weights, each
// flagged field counts by its historical correction evidence (1..2) instead
// of flat 1 — error-prone fields cost more expected effort.
export function reviewEffort(
  kase: ClerkCase,
  weights?: Map<string, number>,
): number {
  const flagged = (kase.extraction?.fields ?? [])
    .filter((f) => f.flagged)
    .reduce((acc, f) => acc + (weights?.get(f.field) ?? 1), 0);
  const preflight = Array.isArray(kase.preflight) ? kase.preflight.length : 0;
  return flagged + preflight;
}

// The kill-switch toast, shared by the Clerk pages: one title, destructive
// tone; each page states its own consequence as the description.
export function clerkDisabledToast(
  toast: ReturnType<typeof useToast>["toast"],
  description: string,
): void {
  toast({
    title: "Clerk is switched off",
    description,
    variant: "destructive",
  });
}

// The generic gateway-error toast: relay the server's own words when it sent
// any, otherwise the caller's fallback.
export function serverErrorToast(
  toast: ReturnType<typeof useToast>["toast"],
  err: unknown,
  fallback: string,
): void {
  toast({
    title: "Something went wrong",
    description: serverErrorMessage(err) ?? fallback,
    variant: "destructive",
  });
}

export function fieldValue(kase: ClerkCase, field: string): string {
  return (
    kase.extraction?.fields.find((f) => f.field === field)?.value ?? ""
  );
}

// Read a File into plain base64. Bytes are encoded directly (chunked to stay
// under the argument limit), so no data: URL prefix is ever produced — the
// backend strips one anyway.
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fileIsPdf(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.toLowerCase().endsWith(".pdf")
  );
}

// Source snippets can quote a whole paragraph; ~300 chars is plenty to verify
// where a value came from.
export function truncateSnippet(s: string): string {
  return s.length > 300 ? `${s.slice(0, 300)}…` : s;
}

// Coarse "n min ago" for claim ages — precision doesn't matter here.
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

// "78" -> "1:18" for the voice-note duration chip on the transcript card.
export function voiceDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const r = Math.max(0, Math.round(sec % 60));
  return `${m}:${String(r).padStart(2, "0")}`;
}

// Operator ids are opaque — show enough to tell operators apart.
export function shortActor(id: string | null | undefined): string {
  if (!id) return "unknown";
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

export interface ApproveForm {
  firmId: string;
  supplierPartyId: string;
  buyerPartyId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  category: ClerkCaseDecisionInputCategory;
  lines: InvoiceLineInput[];
}

// The API takes VAT rates as FRACTIONS ("0.075" = 7.5%) and rejects
// percent-style values loudly. The operator edits a percent in this form, so
// we normalise the extracted value to percent for display and convert back to
// a fraction on submit. If extraction found no usable VAT rate we leave the
// field EMPTY — never invent a default tax rate; the operator must enter one
// deliberately before approval is allowed.
export function vatPercentFromRaw(raw: string | null): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  const n = Number(trimmed.replace("%", "").trim());
  if (!Number.isFinite(n) || n < 0) return "";
  if (trimmed.includes("%")) return String(n);
  // Round away float artifacts (0.07 * 100 → 7.000000000000001).
  return String(n <= 1 ? Number((n * 100).toFixed(6)) : n);
}

export function vatFractionFromPercent(pct: string): string {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return "";
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return pct;
  return String(n / 100);
}

// A line's VAT % is submittable only if it is an explicit number in [0, 100].
export function vatPercentInvalid(pct: string): boolean {
  const trimmed = String(pct).replace("%", "").trim();
  if (!trimmed) return true;
  const n = Number(trimmed);
  return !Number.isFinite(n) || n < 0 || n > 100;
}

export function approveFormFromCase(kase: ClerkCase): ApproveForm {
  return {
    firmId: "",
    supplierPartyId: "",
    buyerPartyId: "",
    invoiceNumber: fieldValue(kase, "invoiceNumber"),
    issueDate: fieldValue(kase, "issueDate"),
    dueDate: fieldValue(kase, "dueDate"),
    currency: fieldValue(kase, "currency") || "NGN",
    category: "b2b",
    lines: (kase.extraction?.lines ?? []).map((l) => ({
      description: l.description ?? "",
      quantity: l.quantity ?? "1",
      unitPrice: l.unitPrice ?? "0",
      vatRate: vatPercentFromRaw(l.vatRate),
    })),
  };
}

// How each capture source presents in the intake queue and detail header.
const INTAKE_KIND: Record<
  string,
  { label: string; eyebrow: string; icon: LucideIcon }
> = {
  voice: { label: "Voice note", eyebrow: "Voice intake", icon: Mic },
  pdf: { label: "Invoice scan", eyebrow: "Document intake", icon: ScanLine },
  image: { label: "Invoice scan", eyebrow: "Document intake", icon: ScanLine },
  text: { label: "Message", eyebrow: "Text intake", icon: MessageSquareText },
};

export function intakeKind(sourceType: string | null | undefined) {
  return (
    INTAKE_KIND[sourceType ?? ""] ?? {
      label: "Document",
      eyebrow: "Document intake",
      icon: FileText,
    }
  );
}

// "invoiceNumber" -> "Invoice number" for the extracted key-value rows.
export function fieldLabel(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Batch-aware queue grouping (round-8 idea #3): cases that came out of the
// same async bundle coalesce into one group at the position of their
// best-ranked member, so the fast-lane/effort ordering still decides WHERE a
// bundle surfaces while its segments stay together. Unbatched cases pass
// through untouched — a queue with no bundles renders exactly as before.
export interface QueueGroup {
  batchId: string | null; // null = a single unbatched case
  cases: ClerkCase[];
}

export function groupQueueByBatch(sorted: ClerkCase[]): QueueGroup[] {
  const groups: QueueGroup[] = [];
  const byBatch = new Map<string, QueueGroup>();
  for (const c of sorted) {
    const batchId = c.batchId ?? null;
    if (!batchId) {
      groups.push({ batchId: null, cases: [c] });
      continue;
    }
    const existing = byBatch.get(batchId);
    if (existing) {
      existing.cases.push(c);
    } else {
      const group: QueueGroup = { batchId, cases: [c] };
      byBatch.set(batchId, group);
      groups.push(group);
    }
  }
  return groups;
}
