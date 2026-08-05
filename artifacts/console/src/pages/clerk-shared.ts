// Pure helpers shared across the Clerk pages (clerk.tsx, clerk-claims.tsx,
// clerk-health.tsx): status tones, the fast-lane predicate, intake-source
// presentation, the approval form's VAT normalisation, and the shared toast
// payloads. No hooks and no JSX live here, so the module is directly
// unit-testable (clerk-shared.test.ts).
import type {
  ClerkBulkApproveReport,
  ClerkCase,
  ClerkCaseDecisionInput,
  ClerkCaseDecisionInputCategory,
  ClerkPartySuggestions,
  InvoiceLineInput,
  NoticeDecisionInput,
} from "@workspace/api-client-react";
import {
  NoticeDecisionInputAuthority,
  NoticeDecisionInputNoticeType,
  NoticeDecisionInputTaxType,
} from "@workspace/api-client-react";
import { fieldLabel } from "@workspace/format/notice-copy";
import type { LucideIcon } from "lucide-react";
import { FileText, MessageSquareText, Mic, ScanLine } from "lucide-react";
import type { useToast } from "@/hooks/use-toast";
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
// The confidence bar is the case's own fastLaneThreshold, derived server-side
// from calibration evidence (modules/clerk/metrics.ts); 0.9 is only the
// wire-absent fallback for older servers that don't send one. Purely a
// triage hint: approval still needs the operator's eyes.
export function isReadyToApprove(kase: ClerkCase): boolean {
  // The fast lane is for invoice extraction cases ONLY: a notice approval
  // creates a statutory response obligation, and a question case never
  // approves at all — neither may ever carry a "Ready" marker or ride a
  // bulk approval.
  if (kase.kind !== "extraction") return false;
  if (kase.status !== "extracted") return false;
  if (!Array.isArray(kase.preflight)) return false;
  if (kase.preflight.some((i) => i.severity !== "advisory")) return false;
  const threshold = kase.fastLaneThreshold ?? 0.9;
  return (kase.extraction?.fields ?? []).every(
    (f) => !f.critical || (f.value != null && f.confidence >= threshold),
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

// The generic gateway-error toast now lives in @/lib/errors (it was never
// Clerk-specific); re-exported so the Clerk pages keep their one import site.
export { serverErrorToast } from "@/lib/errors";

function fieldValue(kase: ClerkCase, field: string): string {
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

// Data URI for a stored source image / rendered page. The wire carries plain
// base64 with no content type, so sniff the subtype from the base64 header
// bytes (PNG, JPEG and WebP are the only formats the intake accepts; PNG is
// the fallback because rendered scan pages are always PNG).
export function imageDataUri(b64: string): string {
  const subtype = b64.startsWith("iVBORw0KGgo")
    ? "png"
    : b64.startsWith("/9j/")
      ? "jpeg"
      : b64.startsWith("UklGR")
        ? "webp"
        : "png";
  return `data:image/${subtype};base64,${b64}`;
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

// The one approve-decision builder: turns the review pane's ApproveForm into
// the wire payload (trimmed invoice number, empty due date -> null, VAT
// percent -> fraction, empty reason -> null). The single-approve button and
// the fast-lane bulk items both call THIS function, so the two paths can
// never drift apart on how a confirmed form becomes a decision.
export function approveDecisionFromForm(
  form: ApproveForm,
  reason: string,
): ClerkCaseDecisionInput {
  return {
    action: "approve",
    firmId: form.firmId,
    supplierPartyId: form.supplierPartyId,
    buyerPartyId: form.buyerPartyId,
    invoiceNumber: form.invoiceNumber.trim(),
    issueDate: form.issueDate,
    dueDate: form.dueDate || null,
    currency: form.currency,
    category: form.category,
    lines: form.lines.map((l) => ({
      ...l,
      vatRate: vatFractionFromPercent(l.vatRate),
    })),
    reason: reason || null,
  };
}

// The bulk flow's prefill: the SAME approveFormFromCase seed the single
// review pane opens with, plus the two auto-selections the single flow makes
// before the operator touches anything — the case's own firm (the only firm
// the server will accept for a firm-attributed case; an operator capture has
// none and the server then skips the row with a named reason) and the top
// party suggestion per slot (exactly the pre-selection effect in clerk.tsx).
// Slots that stay empty ride along as-is: the server's DECISION_INCOMPLETE
// check names them in the per-row skip reason, and the case is left exactly
// as it was for the single-case path.
export function bulkApproveFormFromCase(
  kase: ClerkCase,
  suggestions?: ClerkPartySuggestions,
): ApproveForm {
  const form = approveFormFromCase(kase);
  return {
    ...form,
    firmId: form.firmId || (kase.firmId ?? ""),
    supplierPartyId:
      form.supplierPartyId || (suggestions?.supplier[0]?.partyId ?? ""),
    buyerPartyId: form.buyerPartyId || (suggestions?.buyer[0]?.partyId ?? ""),
  };
}

// One line per case in the bulk-approve confirmation dialog: who billed,
// which invoice, how much — enough for the operator to recognise each case
// before approving the lot.
export interface FastLaneCaseSummary {
  supplier: string;
  invoiceNumber: string;
  amount: string;
}

export function fastLaneCaseSummary(kase: ClerkCase): FastLaneCaseSummary {
  const supplier = fieldValue(kase, "supplierName");
  const number = fieldValue(kase, "invoiceNumber");
  const total = fieldValue(kase, "grandTotal");
  const currency = fieldValue(kase, "currency");
  return {
    supplier: supplier || kase.sourceName || "Unknown supplier",
    invoiceNumber: number || "—",
    amount: total ? (currency ? `${total} ${currency}` : total) : "—",
  };
}

// Which body the bulk-approve dialog shows. The candidate list is LIVE — the
// queue refetches while the dialog is open (window focus, another operator
// deciding cases), so the fast lane can drain to zero underneath it. An empty
// batch is a contract 400, so a drained dialog must disable confirm and say
// why instead of offering a dead button. Precedence: once the report is in,
// the outcomes view owns the dialog; while a batch is in flight the in-flight
// items govern (the rows were snapshotted at click), so neither counts as
// drained.
export type BulkDialogPhase = "report" | "review" | "drained";

export function bulkDialogPhase(args: {
  hasReport: boolean;
  candidateCount: number;
  approvalPending: boolean;
}): BulkDialogPhase {
  if (args.hasReport) return "report";
  if (args.candidateCount === 0 && !args.approvalPending) return "drained";
  return "review";
}

// The bulk report, folded for display: how many drafts were created plus one
// named reason per skipped case (a skipped case was left exactly as it was).
export function bulkApproveSummary(report: ClerkBulkApproveReport): {
  approved: number;
  skipped: { caseId: string; reason: string }[];
} {
  const skipped = report.results
    .filter((r) => r.outcome === "skipped")
    .map((r) => ({ caseId: r.caseId, reason: r.reason ?? "skipped" }));
  return { approved: report.results.length - skipped.length, skipped };
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

function intakeKind(sourceType: string | null | undefined) {
  return (
    INTAKE_KIND[sourceType ?? ""] ?? {
      label: "Document",
      eyebrow: "Document intake",
      icon: FileText,
    }
  );
}

// "invoiceNumber" -> "Invoice number" for the extracted key-value rows — the
// shared @workspace/format/notice-copy helper (one home with the SME app and
// mobile), imported above because noticeFieldLabel falls through to it and
// re-exported so callers keep this import site.
export { fieldLabel };

// ---- Notice cases (Notice Desk) --------------------------------------------
// A notice case is a photographed/uploaded tax-authority notice. Approval
// never creates an invoice: it records a response OBLIGATION (client,
// authority, response deadline). The closed catalogues' display vocabulary
// (label maps + humanize-fallback helpers, the maps every select in the
// notice decision form and the obligations card renders from) lives in
// @workspace/format/notice-copy — the ONE home shared with the SME app and
// mobile — re-exported here so the console keeps its import site.
export {
  AUTHORITY_LABELS,
  authorityLabel,
  NOTICE_TYPE_LABELS,
  noticeTypeLabel,
  TAX_TYPE_LABELS,
  taxTypeLabel,
} from "@workspace/format/notice-copy";

// Notice extraction fields carry a few labels the generic camelCase spacing
// gets wrong (acronyms); everything else falls through to fieldLabel.
const NOTICE_FIELD_LABELS: Record<string, string> = {
  referenceNumber: "Reference number",
  amountDemanded: "Amount demanded",
  responseDueDate: "Response due date",
  tin: "TIN",
  taxpayerTin: "Taxpayer TIN",
  firsOffice: "FIRS office",
};

export function noticeFieldLabel(field: string): string {
  return NOTICE_FIELD_LABELS[field] ?? fieldLabel(field);
}

// Normalise a free-text extracted value onto a closed catalogue: "FIRS" ->
// "firs", "State IRS" -> "state_irs", "Stamp duty" -> "stamp_duty". Anything
// that doesn't land exactly on an option prefills NOTHING — the operator
// must pick deliberately, the model never smuggles a choice in.
export function closedOption<T extends string>(
  catalogue: Record<string, T>,
  raw: string | null | undefined,
): T | "" {
  if (!raw) return "";
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (Object.values(catalogue) as string[]).includes(norm)
    ? (norm as T)
    : "";
}

function noticeFieldValue(kase: ClerkCase, field: string): string {
  return (
    kase.noticeExtraction?.fields.find((f) => f.field === field)?.value ?? ""
  );
}

export interface NoticeApproveForm {
  firmId: string;
  clientPartyId: string;
  noticeType: NoticeDecisionInputNoticeType | "";
  authority: NoticeDecisionInputAuthority | "";
  reference: string;
  taxType: NoticeDecisionInputTaxType | "";
  period: string;
  amount: string;
  currency: string;
  issueDate: string;
  responseDueDate: string;
  notes: string;
}

// The notice decision form's prefill: extraction values seed the inputs
// (referenceNumber -> reference, amountDemanded -> amount), the enum-bound
// selects only prefill when the extracted text lands exactly on a catalogue
// option, and the firm defaults to the case's own firm (same auto-selection
// the invoice bulk prefill makes). The client party always starts empty —
// pinning a notice to the wrong client is the costly mistake here.
export function noticeApproveFormFromCase(kase: ClerkCase): NoticeApproveForm {
  return {
    firmId: kase.firmId ?? "",
    clientPartyId: "",
    noticeType: closedOption(
      NoticeDecisionInputNoticeType,
      kase.noticeExtraction?.noticeType,
    ),
    authority: closedOption(
      NoticeDecisionInputAuthority,
      noticeFieldValue(kase, "authority"),
    ),
    reference:
      noticeFieldValue(kase, "referenceNumber") ||
      noticeFieldValue(kase, "reference"),
    taxType: closedOption(
      NoticeDecisionInputTaxType,
      noticeFieldValue(kase, "taxType"),
    ),
    period: noticeFieldValue(kase, "period"),
    amount:
      noticeFieldValue(kase, "amountDemanded") ||
      noticeFieldValue(kase, "amount"),
    currency: noticeFieldValue(kase, "currency"),
    issueDate: noticeFieldValue(kase, "issueDate"),
    responseDueDate: noticeFieldValue(kase, "responseDueDate"),
    notes: "",
  };
}

// Approve is held until the obligation the server will create is fully
// determined: which firm, which client, what kind of notice, from whom, and
// by when a response is due. Everything else is optional context.
export function noticeApproveDisabled(
  form: NoticeApproveForm | null,
): boolean {
  return (
    !form ||
    !form.firmId ||
    !form.clientPartyId ||
    !form.noticeType ||
    !form.authority ||
    !form.responseDueDate
  );
}

// The one notice approve-decision builder (the invoice form's
// approveDecisionFromForm twin): trims free-text inputs and OMITS empty
// optionals — the contract's optional fields are absent-or-valued, never "".
export function noticeDecisionFromForm(
  form: NoticeApproveForm,
  reason: string,
): NoticeDecisionInput {
  return {
    action: "approve",
    firmId: form.firmId,
    clientPartyId: form.clientPartyId,
    // Guarded by noticeApproveDisabled before submit ever fires.
    noticeType: form.noticeType as NoticeDecisionInputNoticeType,
    authority: form.authority as NoticeDecisionInputAuthority,
    responseDueDate: form.responseDueDate,
    ...(form.reference.trim() ? { reference: form.reference.trim() } : {}),
    ...(form.taxType ? { taxType: form.taxType } : {}),
    ...(form.period.trim() ? { period: form.period.trim() } : {}),
    ...(form.amount.trim() ? { amount: form.amount.trim() } : {}),
    ...(form.currency.trim() ? { currency: form.currency.trim() } : {}),
    ...(form.issueDate ? { issueDate: form.issueDate } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
}

// How a case presents in the queue and the detail header: source presentation
// (icon) from intakeKind, with notice cases relabelled — a photographed
// notice must never masquerade as an "Invoice scan".
export function caseIntakeKind(
  kase: Pick<ClerkCase, "kind" | "sourceType">,
): { label: string; eyebrow: string; icon: LucideIcon } {
  const base = intakeKind(kase.sourceType);
  if (kase.kind !== "notice") return base;
  return { ...base, label: "Tax notice", eyebrow: "Notice intake" };
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
