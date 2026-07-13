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
