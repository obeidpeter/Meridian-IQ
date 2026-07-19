/**
 * Pure helpers behind the "Send to Clerk" capture screen: the status→badge
 * mapping, the pdf-vs-image sniffing for picked documents, the camera-shot →
 * case-input assembly (size guard included), and the camelCase→sentence-case
 * labelling of extracted fields. Kept free of React Native imports so the
 * node:test suite can exercise them directly.
 */

import type {
  ClerkCaseCreateInput,
  ClerkCaseStatus,
} from "@workspace/api-client-react";

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

// The API server caps JSON bodies at 8 MB and base64 inflates a file by ~4/3,
// so anything over ~5 MB raw would bounce with an opaque 413. Both capture
// paths (file pick and camera) catch it locally with a friendlier message.
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

// The camera guard's copy suggests fixes the photographer controls — framing
// distance and camera resolution — rather than a bare "too big".
export const CAMERA_RETAKE_MESSAGE =
  "That photo is too large to send. Retake it from a little further back, or lower your camera's photo resolution.";

export const CAMERA_EMPTY_MESSAGE =
  "The photo couldn't be read. Please take it again.";

/**
 * Decoded byte count of a base64 string — what the server will actually
 * receive — without materialising a buffer. Tolerates unpadded output (some
 * Android encoders omit the trailing `=`).
 */
export function base64ByteLength(base64: string): number {
  const s = base64.trim();
  if (!s) return 0;
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

/**
 * Camera shots arrive without a filename, so give them a stable, sortable one
 * for the submissions list: `photo-YYYYMMDD-HHMMSS.jpg` (UTC, so the name is
 * deterministic for a given instant regardless of device timezone).
 */
export function cameraPhotoName(capturedAt: Date): string {
  const iso = capturedAt.toISOString(); // e.g. 2026-07-19T14:32:05.123Z
  const date = iso.slice(0, 10).replace(/-/g, "");
  const time = iso.slice(11, 19).replace(/:/g, "");
  return `photo-${date}-${time}.jpg`;
}

export type CameraCaseBuild =
  | { ok: true; input: ClerkCaseCreateInput }
  | { ok: false; message: string };

/**
 * Turn a camera capture's base64 JPEG into the same `image` case submission a
 * picked photo file produces, or refuse with user-facing copy. expo-image-
 * picker always transcodes camera output to JPEG when returning base64, so
 * the content type is fixed rather than sniffed.
 */
export function buildCameraCaseInput(
  base64: string,
  capturedAt: Date,
): CameraCaseBuild {
  const bytes = base64ByteLength(base64);
  if (bytes === 0) return { ok: false, message: CAMERA_EMPTY_MESSAGE };
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, message: CAMERA_RETAKE_MESSAGE };
  }
  return {
    ok: true,
    input: {
      sourceType: "image",
      name: cameraPhotoName(capturedAt),
      contentType: "image/jpeg",
      imageBase64: base64,
    },
  };
}

/** "invoiceNumber" → "Invoice number" for the extracted key→value rows. */
export function fieldLabel(field: string): string {
  const spaced = field.replace(/([A-Z])/g, " $1").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
