import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { DomainError } from "../errors";
import { publicAppLink, publicAppUrl } from "../../lib/public-app-url";

export const ROOM_SESSION_TTL_MS = 30 * 60 * 1000;
export const ROOM_OTP_TTL_MS = 10 * 60 * 1000;

export function makeRoomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function digestRoomSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function roomOtpDigest(sessionToken: string, code: string): string {
  return digestRoomSecret(`otp\0${sessionToken}\0${code}`);
}

export function safeDigestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function decodeEncryptionKey(value: string | undefined): Buffer | null {
  const configured = value?.trim();
  if (!configured) return null;
  const key = /^[0-9a-f]{64}$/i.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  return key.length === 32 ? key : null;
}

export function invoiceRoomSecurityConfiguration(): {
  encryptionKeyConfigured: boolean;
  publicUrlConfigured: boolean;
} {
  return {
    encryptionKeyConfigured: Boolean(
      decodeEncryptionKey(process.env.INVOICE_ROOM_ENCRYPTION_KEY),
    ),
    publicUrlConfigured: Boolean(publicAppUrl()),
  };
}

function encryptionKey(): Buffer {
  const configured = process.env.INVOICE_ROOM_ENCRYPTION_KEY;
  if (configured?.trim()) {
    const key = decodeEncryptionKey(configured);
    if (!key) {
      throw new DomainError(
        "INVOICE_ROOM_CONFIGURATION",
        "Invoice Room encryption is not configured correctly",
        503,
      );
    }
    return key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new DomainError(
      "INVOICE_ROOM_CONFIGURATION",
      "Invoice Room encryption is not configured",
      503,
    );
  }
  // Stable local/test fallback only. Production requires a dedicated secret
  // so a copied database cannot recover share credentials.
  return createHash("sha256")
    .update(process.env.DATABASE_URL ?? "meridian-invoice-room-development")
    .digest();
}

export function encryptRoomToken(token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted]
    .map((part) => part.toString("base64url"))
    .join(".");
}

export function decryptRoomToken(value: string): string {
  const parts = value.split(".");
  if (parts.length !== 3) {
    throw new DomainError(
      "INVOICE_ROOM_CREDENTIAL",
      "Invoice Room credential cannot be recovered",
      503,
    );
  }
  try {
    const [iv, tag, encrypted] = parts.map((part) =>
      Buffer.from(part, "base64url"),
    );
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new DomainError(
      "INVOICE_ROOM_CREDENTIAL",
      "Invoice Room credential cannot be recovered",
      503,
    );
  }
}

// The bearer stays after '#', which browsers do not send in HTTP requests,
// access logs or Referer headers. The landing app exchanges it from the body
// and immediately clears the fragment. The origin is PUBLIC_APP_URL and
// nothing else (lib/public-app-url.ts, R112): production fails closed here
// when it is unset or unsafe.
export function invoiceRoomLink(token: string): string {
  const link = publicAppLink("/invoice-room", { token });
  if (!link) {
    throw new DomainError(
      "INVOICE_ROOM_CONFIGURATION",
      "Invoice Room public URL is not configured correctly",
      503,
    );
  }
  return link;
}

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "••••";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"•".repeat(Math.max(2, Math.min(6, local.length - visible.length)))}@${domain}`;
}

export function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return `${phone.slice(0, Math.min(4, phone.length))} •••• ${phone.slice(-3)}`;
}
