import type {
  EvidenceMediaType,
  EvidencePrincipal,
  EvidenceVersion,
} from "./evidence-types";
import { knownEvidenceError } from "./evidence-errors";

export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;
export const evidenceKinds = [
  "purchase_order",
  "delivery_note",
  "payment_receipt",
  "tax_acknowledgement",
  "contract",
  "other",
] as const;
export const evidenceStatuses = [
  "requested",
  "uploaded",
  "needs_changes",
  "accepted",
  "cancelled",
] as const;
export const evidenceLabel = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
export const evidenceDate = (value: string | null) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Not set";
export const evidenceUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );

export function evidencePermissions(me: EvidencePrincipal) {
  const staff = me.role === "firm_admin" || me.role === "firm_staff";
  const read =
    me.features.includes("evidence_hub") &&
    me.capabilities.includes("evidence.read");
  return {
    read,
    request: read && staff && me.capabilities.includes("evidence.request"),
    review: read && staff && me.capabilities.includes("evidence.review"),
    upload: read && me.capabilities.includes("evidence.upload"),
  };
}

export function evidenceErrorStatus(error: unknown): number | undefined {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    typeof error.status === "number"
    ? error.status
    : undefined;
}
export function evidenceError(error: unknown): string {
  const status = evidenceErrorStatus(error);
  const known = knownEvidenceError(error, status);
  if (known) return known;
  switch (status) {
    case 400:
    case 422:
      return "The request was not accepted. Check the fields and selected document.";
    case 401:
      return "Your session has expired. Sign in again before continuing.";
    case 403:
      return "Your account no longer has access to this evidence.";
    case 404:
      return "This evidence is unavailable or Evidence Hub is not enabled.";
    case 409:
      return "This request changed or the document is not ready. Refresh the record before trying again.";
    case 413:
      return "The document exceeds the 5 MB limit.";
    case 415:
      return "Choose a JPEG, PNG or PDF document.";
    case 429:
      return "Too many requests. Wait a moment, then retry.";
    default:
      return "The operation could not be confirmed. Retry to recover the same attempt.";
  }
}

export function readEvidenceBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The document could not be read."));
    reader.onabort = () => reject(new Error("Document reading was cancelled."));
    reader.onload = () =>
      reader.result instanceof ArrayBuffer
        ? resolve(reader.result)
        : reject(new Error("The document could not be read."));
    reader.readAsArrayBuffer(blob);
  });
}

export function evidenceMagic(bytes: Uint8Array): EvidenceMediaType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte))
    return "image/png";
  if ([37, 80, 68, 70, 45].every((byte, i) => bytes[i] === byte))
    return "application/pdf";
  return null;
}

export async function evidenceUploadContent(file: File) {
  if (!file.size || file.size > EVIDENCE_MAX_BYTES)
    throw new Error("Choose a non-empty document no larger than 5 MB.");
  if (!file.name.trim() || file.name.length > 160)
    throw new Error("The document name must be between 1 and 160 characters.");
  if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type))
    throw new Error("Choose a JPEG, PNG or PDF document.");
  const bytes = new Uint8Array(await readEvidenceBytes(file));
  const contentType = evidenceMagic(bytes);
  if (contentType !== file.type)
    throw new Error("The document contents do not match its file type.");
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return { filename: file.name, contentType, contentBase64: btoa(binary) };
}

export function evidenceFilename(
  filename: string,
  type: EvidenceMediaType | "application/zip",
) {
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "application/pdf": "pdf",
    "application/zip": "zip",
  }[type];
  const stem =
    filename
      .replace(/\.[^.]*$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "evidence";
  return `${stem}.${extension}`;
}

export async function checkedEvidenceBlob(blob: Blob, file: EvidenceVersion) {
  if (file.scanStatus !== "clean")
    throw new Error("This document is not cleared for download.");
  if (blob.size !== file.byteSize || blob.size > EVIDENCE_MAX_BYTES)
    throw new Error("The downloaded document did not match the file record.");
  const bytes = await readEvidenceBytes(blob.slice(0, 8));
  if (evidenceMagic(new Uint8Array(bytes)) !== file.contentType)
    throw new Error(
      "The downloaded document type did not match the file record.",
    );
  return new Blob([blob], { type: file.contentType });
}

export function saveEvidenceBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener noreferrer";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
