import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { getSessionSecret, signSessionPayload } from "./session";

// TOTP two-factor authentication (SEC-02), hand-rolled on node:crypto — no new
// dependencies. RFC 6238 TOTP over RFC 4226 HOTP: HMAC-SHA1, 30-second step,
// 6 digits, verification window of ±1 step. Secrets are RFC 4648 base32
// (no padding) for authenticator-app compatibility. Everything here is
// deterministic and unit-testable: time-dependent functions accept an injected
// epoch-ms so the RFC test vectors run exactly.
//
// The module also owns the short-lived "mfa pending" token minted by
// /auth/login for an enrolled account: same HMAC machinery and persisted
// signing secret as the session token (session.ts), but with a distinct
// purpose prefix baked into the signed payload — and a COLON-separated payload
// where sessions use dots — so neither parser can ever accept the other's
// token, even though they share a key.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_WINDOW_STEPS = 1;

// ---- base32 (RFC 4648, no padding) ----

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(encoded: string): Buffer {
  // Tolerate the common presentation variants (lowercase, spaces, trailing
  // padding) so a secret pasted back from an authenticator app still decodes.
  const clean = encoded.toUpperCase().replace(/[\s=]+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 input");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- HOTP / TOTP (RFC 4226 / RFC 6238, HMAC-SHA1) ----

export function hotp(key: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", key).update(msg).digest();
  // Dynamic truncation (RFC 4226 §5.3).
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

export function totpStep(epochMs: number): number {
  return Math.floor(epochMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretBase32: string, epochMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(epochMs));
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export interface TotpMatch {
  // The 30s step the code matched, for the caller to persist as
  // totp_last_used_step (single-use enforcement, RFC 6238 §5.2).
  step: number;
}

// Verify a 6-digit code against the secret within ±TOTP_WINDOW_STEPS of the
// current step. `lastUsedStep` (when provided) rejects any code at or before
// the step a code was last accepted for, so an observed code cannot be
// replayed within its own validity window. All window candidates are compared
// (no early exit) with a constant-time equality, so the comparison leaks
// nothing about which step — if any — matched.
export function verifyTotpCode(
  secretBase32: string,
  code: string,
  opts: { nowMs?: number; lastUsedStep?: number | null } = {},
): TotpMatch | null {
  const normalized = code.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null;
  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return null;
  }
  const current = totpStep(opts.nowMs ?? Date.now());
  let matched: number | null = null;
  for (
    let step = current - TOTP_WINDOW_STEPS;
    step <= current + TOTP_WINDOW_STEPS;
    step++
  ) {
    if (constantTimeEqual(hotp(key, step), normalized) && matched === null) {
      matched = step;
    }
  }
  if (matched === null) return null;
  if (opts.lastUsedStep != null && matched <= opts.lastUsedStep) return null;
  return { step: matched };
}

// ---- enrolment material ----

export function generateTotpSecret(): string {
  // 20 random bytes = the SHA-1 block-friendly 160-bit key RFC 4226 recommends.
  return base32Encode(randomBytes(20));
}

export function buildOtpauthUri(email: string, secret: string): string {
  const issuer = "MeridianIQ";
  return (
    `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

export const RECOVERY_CODE_COUNT = 8;
export const RECOVERY_CODE_LENGTH = 10;
// Readable alphabet: no I/L/O/U/0/1 — nothing a user can mis-transcribe.
const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

// Case/punctuation-insensitive canonical form, so "abcd-efgh-ij" redeems the
// code shown as "ABCDEFGHIJ". Both hashing and lookup go through this.
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

// 8 single-use codes, shown once; only the sha256 hashes are stored (the same
// posture as invitation and password-reset tokens).
export function generateRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let code = "";
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(code);
  }
  return { codes, hashes: codes.map(hashRecoveryCode) };
}

// ---- mfa pending token: base64url(mfa:userId:expiryMs:epoch).signature ----

// Short-lived: the token only bridges the gap between a correct password and a
// correct second factor. It grants nothing but the right to attempt
// /auth/totp/challenge.
export const MFA_TOKEN_TTL_MS = 5 * 60 * 1000;
const MFA_PREFIX = "mfa";

export async function issueMfaToken(
  userId: string,
  sessionEpoch: number,
  nowMs: number = Date.now(),
): Promise<string> {
  const secret = await getSessionSecret();
  const payload = Buffer.from(
    `${MFA_PREFIX}:${userId}:${nowMs + MFA_TOKEN_TTL_MS}:${sessionEpoch}`,
  ).toString("base64url");
  return `${payload}.${signSessionPayload(payload, secret)}`;
}

export interface VerifiedMfaToken {
  userId: string;
  // The session epoch at password-verification time; the challenge route
  // compares it to the user's current epoch so a password change between login
  // and challenge revokes the pending token like any session (SEC-02).
  epoch: number;
}

export async function verifyMfaToken(
  token: string,
  nowMs: number = Date.now(),
): Promise<VerifiedMfaToken | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const secret = await getSessionSecret();
  const expected = signSessionPayload(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, "base64url").toString();
  // Colon-separated with a literal purpose prefix: a session payload
  // (dot-separated userId.expiry.epoch) can never split into these four
  // fields, and this payload can never satisfy the session parser's
  // dot-separated shape — the two token kinds are mutually unreadable even
  // under the shared signing secret.
  const parts = decoded.split(":");
  if (parts.length !== 4 || parts[0] !== MFA_PREFIX) return null;
  const [, userId, expiryRaw, epochRaw] = parts;
  const expiry = Number(expiryRaw);
  const epoch = Number(epochRaw);
  if (!userId || !Number.isFinite(expiry) || !Number.isFinite(epoch)) {
    return null;
  }
  if (nowMs > expiry) return null;
  return { userId, epoch };
}
