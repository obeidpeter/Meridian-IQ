import { humanize, pillClasses, type BadgeTone } from "@/lib/format";

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
