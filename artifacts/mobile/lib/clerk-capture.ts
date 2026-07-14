/**
 * Pure helpers behind the "Send to Clerk" capture screen: the status→badge
 * mapping, the pdf-vs-image sniffing for picked documents, and the
 * camelCase→sentence-case labelling of extracted fields. Kept free of React
 * Native imports so the node:test suite can exercise them directly.
 */

import type { ClerkCaseStatus } from "@workspace/api-client-react";

import type { BadgeTone } from "@/components/ui";

export interface ClerkStatusMeta {
  tone: BadgeTone;
  label: string;
}

// Mirrors the console's intake-queue wording so both clients tell the same
// story: a case is "read" by Clerk, then a human accountant reviews it.
export const CLERK_STATUS_META: Record<ClerkCaseStatus, ClerkStatusMeta> = {
  pending: { tone: "neutral", label: "Reading…" },
  extracted: { tone: "info", label: "Waiting for review" },
  in_review: { tone: "info", label: "In review" },
  approved: { tone: "success", label: "Approved" },
  rejected: { tone: "critical", label: "Rejected" },
  escalated: { tone: "warning", label: "Escalated" },
  failed: { tone: "critical", label: "Needs input" },
};

/** Badge meta for a case status, tolerating unknown values from newer servers. */
export function clerkStatusMeta(status: string): ClerkStatusMeta {
  return (
    (CLERK_STATUS_META as Record<string, ClerkStatusMeta>)[status] ?? {
      tone: "neutral",
      label: "Unknown",
    }
  );
}

const IMAGE_EXT = /\.(png|jpe?g|webp|heic|heif|gif|bmp|tiff?)$/i;
const PDF_EXT = /\.pdf$/i;

/**
 * Decide whether a picked document should be submitted as a `pdf` or an
 * `image` case. A specific mime type wins; generic mimes (e.g. Android's
 * `application/octet-stream`) fall back to the filename extension. The picker
 * is restricted to PDFs and images, so anything still ambiguous is treated as
 * a photo — the far more common capture.
 */
export function pickSourceType(name: string, mime?: string): "pdf" | "image" {
  const m = (mime ?? "").trim().toLowerCase();
  if (m === "application/pdf" || m === "application/x-pdf") return "pdf";
  if (m.startsWith("image/")) return "image";
  const n = name.trim();
  if (PDF_EXT.test(n)) return "pdf";
  if (IMAGE_EXT.test(n)) return "image";
  return "image";
}

/** "invoiceNumber" → "Invoice number" for the extracted key→value rows. */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
