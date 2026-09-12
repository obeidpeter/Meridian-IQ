import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { DomainError } from "../errors";

export const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;
export const MAX_EVIDENCE_VERSIONS = 20;
export const MAX_FIRM_EVIDENCE_BYTES = 100 * 1024 * 1024;

export function evidenceHash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function configuredKey(): Buffer | null {
  const value = process.env.EVIDENCE_ENCRYPTION_KEY?.trim();
  if (!value) return null;
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 32 && bytes.toString("base64") === value) return bytes;
  }
  return null;
}

export function evidenceStorageAvailable(): boolean {
  if (process.env.EVIDENCE_ENCRYPTION_KEY?.trim())
    return Boolean(configuredKey());
  return process.env.NODE_ENV !== "production";
}

function encryptionKey(): Buffer {
  const key = configuredKey();
  if (key) return key;
  if (!evidenceStorageAvailable())
    throw new DomainError(
      "EVIDENCE_STORAGE_UNAVAILABLE",
      "Secure document storage is not configured. Contact your administrator.",
      503,
    );
  // Local/test only; production backups require the separately held dedicated key.
  return createHash("sha256")
    .update(`valo-evidence-local:${process.env.DATABASE_URL ?? "development"}`)
    .digest();
}

export function encryptEvidence(bytes: Buffer, scope: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(scope));
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted]
    .map((b) => b.toString("base64url"))
    .join(".");
}

export function decryptEvidence(value: string, scope: string): Buffer {
  const key = encryptionKey();
  try {
    const parts = value.split(".");
    if (parts.length !== 3) throw new Error("Invalid envelope");
    const [nonce, tag, data] = parts.map((p) => Buffer.from(p, "base64url"));
    if (nonce.length !== 12 || tag.length !== 16)
      throw new Error("Invalid envelope");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(scope));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new DomainError(
      "EVIDENCE_INTEGRITY_FAILED",
      "This document could not be read safely. Contact support.",
      503,
    );
  }
}

export function validateEvidenceUpload(input: {
  filename: string;
  contentType: string;
  contentBase64: string;
}): Buffer {
  if (
    !input.filename.trim() ||
    input.filename.length > 160 ||
    /[\u0000-\u001f\u007f/\\]/.test(input.filename)
  ) {
    throw new DomainError(
      "EVIDENCE_FILENAME_INVALID",
      "Use a filename without slashes or control characters.",
      400,
    );
  }
  const value = input.contentBase64;
  if (value.length > Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4)
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      "Choose a document smaller than 5 MB.",
      413,
    );
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new DomainError(
      "BAD_UPLOAD",
      "This document could not be read. Choose the file again.",
      400,
    );
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.toString("base64") !== value)
    throw new DomainError(
      "BAD_UPLOAD",
      "This document could not be read. Choose the file again.",
      400,
    );
  if (bytes.length > MAX_EVIDENCE_BYTES)
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      "Choose a document smaller than 5 MB.",
      413,
    );
  assertDocumentSignature(bytes, input.contentType, input.filename);
  return bytes;
}

function assertDocumentSignature(
  bytes: Buffer,
  type: string,
  filename: string,
): void {
  const pdf =
    type === "application/pdf" &&
    /\.pdf$/i.test(filename) &&
    bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
    /%%EOF\s*$/.test(bytes.subarray(-1024).toString("latin1"));
  const png =
    type === "image/png" &&
    /\.png$/i.test(filename) &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes
      .subarray(-12)
      .equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]));
  const jpeg =
    type === "image/jpeg" &&
    /\.jpe?g$/i.test(filename) &&
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217;
  if (!pdf && !png && !jpeg)
    throw new DomainError(
      "EVIDENCE_TYPE_INVALID",
      "Choose a valid PDF, PNG or JPEG with a matching filename.",
      400,
    );
  // Supplementary rejection only; every PDF also requires bounded structural
  // inspection and all content still requires the configured malware scan.
  if (
    pdf &&
    /\/(?:JavaScript|JS|Launch|EmbeddedFile|RichMedia|AA|XFA|SubmitForm|ImportData)\b/i.test(
      bytes
        .toString("latin1")
        .replace(/#([0-9a-f]{2})/gi, (_, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
    )
  )
    throw new DomainError(
      "EVIDENCE_ACTIVE_CONTENT",
      "Use a flattened PDF without scripts or embedded attachments.",
      400,
    );
}
