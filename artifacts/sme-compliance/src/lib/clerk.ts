import { humanize, pillClasses, type BadgeTone } from "@/lib/format";
import { errorStatus, serverErrorMessage } from "@/lib/errors";

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
  const status = errorStatus(err);
  if (status === 503) {
    opts.onDisabled();
    return;
  }
  opts.toast({
    title:
      status === 429 ? "Monthly Clerk allowance used up" : opts.fallbackTitle,
    description: serverErrorMessage(err),
    variant: "destructive",
  });
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
