import type { ClerkCase } from "@workspace/api-client-react";
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
// blocking (an EMPTY array — null/undefined means it never ran, which is not
// the same as clear), and every critical field arrived with a value at high
// confidence. Purely a triage hint: approval still needs the operator's eyes.
export function isReadyToApprove(kase: ClerkCase): boolean {
  if (kase.status !== "extracted") return false;
  if (!Array.isArray(kase.preflight) || kase.preflight.length > 0) return false;
  return (kase.extraction?.fields ?? []).every(
    (f) => !f.critical || (f.value != null && f.confidence >= 0.9),
  );
}
