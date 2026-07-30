import type {
  ClerkAnswer,
  ClerkAnswerLink,
} from "@workspace/api-client-react";
import { humanize, pillClasses, type BadgeTone } from "@/lib/format";
import { clerkBudgetExhausted, killSwitchTripped } from "@workspace/api-errors";
import { serverErrorMessage } from "@/lib/errors";

// ---- Clerk capture cases ---------------------------------------------------
// Client-side view of the Clerk intake lifecycle. Clients only submit and
// watch: every decision (approve/reject/escalate) happens on the operator
// side, so the labels here describe what is happening to the submission from
// the client's seat rather than what an operator should do next.

const CAPTURE_STATUS_LABELS: Record<string, string> = {
  pending: "Clerk is reading",
  extracted: "Awaiting review",
  in_review: "Being reviewed",
  approved: "Approved",
  rejected: "Rejected",
  escalated: "Escalated",
  failed: "Could not read",
};

const CAPTURE_STATUS_TONES: Record<string, BadgeTone> = {
  pending: "slate",
  extracted: "blue",
  in_review: "amber",
  approved: "emerald",
  rejected: "red",
  escalated: "amber",
  failed: "red",
};

/** Client-facing label for a Clerk case status; humanizes unknown statuses. */
export function captureStatusLabel(status: string): string {
  return CAPTURE_STATUS_LABELS[status] ?? humanize(status);
}

/** Status pill classes for a Clerk case status (slate for unknown). */
export function captureBadgeClasses(status: string): string {
  return pillClasses(CAPTURE_STATUS_TONES[status] ?? "slate");
}

// ---- Gateway error handling --------------------------------------------------

/**
 * The shared split for Clerk gateway rejections, used by capture and Ask:
 * 503 CLERK_DISABLED (the kill switch is off) raises the page's banner
 * instead of a toast; 429 CLERK_BUDGET_EXHAUSTED relays the server's own
 * message under the allowance title; anything else (e.g. the typed 422
 * intake rejections, which carry an actionable message) relays the server's
 * words under the page's fallback title.
 */
export function handleClerkGatewayError(
  err: unknown,
  opts: {
    onDisabled: () => void;
    toast: (t: {
      title: string;
      description: string;
      variant: "destructive";
    }) => void;
    fallbackTitle: string;
  },
): void {
  if (killSwitchTripped(err)) {
    opts.onDisabled();
    return;
  }
  opts.toast({
    title: clerkBudgetExhausted(err)
      ? "Monthly Clerk allowance used up"
      : opts.fallbackTitle,
    description: serverErrorMessage(err),
    variant: "destructive",
  });
}

// ---- Ask Clerk -------------------------------------------------------------

/**
 * Scope suffix for a data-grounded Ask answer's "from your records" note:
 * the resolved display labels the server pinned the lookup to (a month
 * label, a client name — never ids), joined for one source line. Empty
 * string when the lookup ran unscoped, so callers can skip the clause.
 */
export function dataAnswerScope(
  dataParams: Record<string, string> | undefined,
): string {
  return Object.values(dataParams ?? {})
    .filter((v) => v.trim().length > 0)
    .join(" · ");
}

/**
 * Deep-linkable invoice references from an answer's links row. Only the
 * invoice kind is navigable in this app, and a link whose id is null/absent
 * (the server named a record the asker cannot open) is dropped rather than
 * rendered as a dead button. The id narrows to a plain string so callers
 * build hrefs without re-checking.
 */
export function invoiceLinks(
  links: ClerkAnswerLink[] | undefined,
): { label: string; id: string }[] {
  return (links ?? []).flatMap((l) =>
    l.kind === "invoice" && l.id != null ? [{ label: l.label, id: l.id }] : [],
  );
}

/**
 * The plan-transparency line over a multi-intent answer (contract 0.56.0):
 * "Answered using: <plan titles joined ' · '>". The titles are app-trusted
 * display strings resolved server-side from the closed intent catalogue and
 * are shown verbatim, in server order, so the line is deterministic. Empty
 * string when the answer carries no plan (single-intent), so the line is
 * simply omitted.
 */
export function planLine(
  answer: Pick<ClerkAnswer, "plan"> | null | undefined,
): string {
  const titles = (answer?.plan ?? [])
    .map((p) => p.title.trim())
    .filter((t) => t.length > 0);
  return titles.length > 0 ? `Answered using: ${titles.join(" · ")}` : "";
}

/**
 * The follow-up chip's label: the scope a threaded follow-up will inherit,
 * read off the held answer's pins. Display labels only — a month label, a
 * client name; the machine pins (monthStart, clientPartyId) never render.
 * Empty string when the answer pins nothing displayable, so the chip is
 * omitted (matching today's UX for plain data answers without pins).
 */
export function followupPinsLine(
  answer: Pick<ClerkAnswer, "pins"> | null | undefined,
): string {
  const labels = [answer?.pins?.monthLabel, answer?.pins?.clientName].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return labels.length > 0 ? `Follow-ups keep: ${labels.join(" · ")}` : "";
}

/**
 * Whether an answer holds the multi-turn thread — i.e. whether the page
 * should keep its case id as previousCaseId for the next question. Since
 * contract 0.56.0 that is any ANSWERED reply carrying scope a follow-up
 * could inherit: a data answer (dataIntent), a multi-intent answer
 * (sections), or explicit pins — machine pins included, because the server
 * threads on those even when there is no label to display. Register-claim
 * answers and refusals still don't thread; and because a refusal must not
 * sever an existing thread, this predicate gates SETTING previousCaseId,
 * never clearing it. Kept semantically identical to the console page's and
 * the mobile lib's copy.
 */
export function holdsFollowupCase(
  answer: ClerkAnswer | null | undefined,
): boolean {
  if (!answer?.answered) return false;
  if (answer.dataIntent) return true;
  if ((answer.sections?.length ?? 0) > 0) return true;
  return Object.values(answer.pins ?? {}).some(
    (v) => typeof v === "string" && v.trim().length > 0,
  );
}

/** The asker's helpfulness signal as held in page state. */
export type AskFeedback = "helpful" | "not_helpful";

/**
 * What a thumb press should submit: pressing the other thumb switches the
 * signal (the server keeps the latest), while pressing the already-selected
 * thumb again is a no-op (null) — the server already holds that signal, so
 * there is nothing to send.
 */
export function feedbackToSubmit(
  current: AskFeedback | null,
  pressed: AskFeedback,
): AskFeedback | null {
  return current === pressed ? null : pressed;
}

// ---- Usage meter -----------------------------------------------------------

/**
 * Percent of the monthly Clerk allowance consumed, rounded and clamped to
 * [0, 100]. A missing/zero/negative budget or non-finite input yields 0 so
 * the meter never renders NaN or overflows its track.
 */
export function usagePct(used: number, budget: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(budget) || budget <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((used / budget) * 100)));
}

/** One per-purpose spend row from GET /clerk/usage's byPurpose array. */
export type UsagePurposeRow = { purpose: string; tokens: number };

/** Purpose rows shown under the meter before folding into "+N more". */
export const USAGE_BREAKDOWN_MAX_ROWS = 4;

/**
 * Rows for the per-purpose breakdown under the usage meter: zero, negative
 * and non-finite spends drop out, the rest sort by tokens descending (ties
 * alphabetical so the order is stable across refetches), and anything past
 * the cap folds into `overflow` for a "+N more" line. A missing array
 * (version skew: new bundle, pre-0.35.0 server) yields the same empty shape
 * as no spend, so the meter renders exactly as before.
 */
export function usageBreakdown(
  byPurpose: UsagePurposeRow[] | undefined,
  maxRows: number = USAGE_BREAKDOWN_MAX_ROWS,
): { rows: UsagePurposeRow[]; overflow: number } {
  const spent = (byPurpose ?? []).filter(
    (r) => Number.isFinite(r.tokens) && r.tokens > 0,
  );
  spent.sort(
    (a, b) => b.tokens - a.tokens || a.purpose.localeCompare(b.purpose),
  );
  return {
    rows: spent.slice(0, maxRows),
    overflow: Math.max(0, spent.length - maxRows),
  };
}

// Compact token counts for the breakdown rows ("12.4K"); built once at module
// load like the shared Intl formatters in @workspace/format.
const TOKEN_COUNT_FORMAT = new Intl.NumberFormat("en-NG", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/**
 * Compact token count: 12_400 → "12.4K". Pair with the exact figure in the
 * element's `title`, per the formatCompactNaira convention. Non-finite input
 * renders the shared "—" placeholder rather than NaN.
 */
export function formatTokens(tokens: number): string {
  return Number.isFinite(tokens) ? TOKEN_COUNT_FORMAT.format(tokens) : "—";
}

// ---- Extraction display ----------------------------------------------------

/** "invoiceNumber" -> "Invoice number" for the extracted key-value rows. */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---- Batch intake ----------------------------------------------------------

/**
 * Friendly one-liner for a multi-invoice batch result, phrased around what
 * the client cares about: how many cases were opened and how many segments
 * were skipped as duplicates. e.g. "Clerk found 3 invoices and opened a case
 * for each · 1 duplicate skipped".
 */
export function batchSummary(opened: number, skippedDuplicates: number): string {
  if (opened === 0) {
    // All-duplicates batches return 200 with no cases; anything else with
    // zero segments is a 4xx, so this branch is effectively "all duplicates".
    return skippedDuplicates > 0
      ? `Clerk found ${skippedDuplicates} invoice${
          skippedDuplicates === 1 ? "" : "s"
        }, but you'd already sent ${skippedDuplicates === 1 ? "it" : "them all"}`
      : "Clerk didn't find any new invoices in that document";
  }
  const found = `Clerk found ${opened} invoice${
    opened === 1 ? "" : "s"
  } and opened a case for ${opened === 1 ? "it" : "each"}`;
  const skipped =
    skippedDuplicates > 0
      ? ` · ${skippedDuplicates} duplicate${
          skippedDuplicates === 1 ? "" : "s"
        } skipped`
      : "";
  return found + skipped;
}

// ---- Upload plumbing -------------------------------------------------------

/** Voice notes are capped server-side at 5 MB — reject bigger files early. */
export const MAX_VOICE_BYTES = 5 * 1024 * 1024;

/**
 * Read a File into plain base64. Bytes are encoded directly (chunked to stay
 * under the argument limit), so no data: URL prefix is ever produced — the
 * backend strips one anyway. Mirrors the console's capture upload path.
 */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
