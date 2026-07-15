import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { getDb, appSecretsTable, usersTable } from "@workspace/db";

// Cookie-session authentication (SEC-02).
//
// The platform's production identity provider is Clerk; this module provides
// the first-party email + password session used by the web apps (and the demo
// environment): scrypt-hashed passwords on the users table, and a stateless
// HMAC-signed session token in an HttpOnly cookie. The signing secret is
// generated once and persisted in app_secrets so sessions survive restarts.

export const SESSION_COOKIE = "miq_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_KEY = "session_hmac_secret";

// The canonical form emails are stored and compared in. Every auth surface
// (login lookup, throttle keying, invitation matching) must key off this one
// helper — if two sites normalized differently, throttle counters and account
// lookups would silently disagree on which account an attempt belongs to.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---- password hashing (scrypt, salt:hash hex) ----

// Async scrypt: the KDF runs on libuv's threadpool, not the event loop. The
// sync variant blocked the single-threaded server for the full KDF on every
// login — including the decoy burn for unknown emails, which an attacker can
// trigger unthrottled by rotating fabricated addresses — making password
// checks an availability lever against every tenant at once.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A throwaway hash used to burn an equivalent scrypt when a login names an
// account that does not exist (or is Clerk-only, no password). Running it keeps
// the not-found branch's latency comparable to a real verify, closing the
// timing side-channel that would otherwise let an attacker enumerate which
// emails have first-party accounts. Lazily initialised so importing this module
// (e.g. from unrelated tests) costs nothing.
let decoyHash: string | null = null;
async function burnDecoyScrypt(password: string): Promise<void> {
  if (decoyHash === null) {
    decoyHash = await hashPassword(randomBytes(16).toString("hex"));
  }
  await verifyPassword(password, decoyHash);
}

// ---- signing secret (generated once, persisted) ----

let cachedSecret: string | null = null;

export async function getSessionSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;
  const [row] = await getDb()
    .select({ value: appSecretsTable.value })
    .from(appSecretsTable)
    .where(eq(appSecretsTable.key, SECRET_KEY))
    .limit(1);
  if (row) {
    cachedSecret = row.value;
    return row.value;
  }
  const secret = randomBytes(32).toString("hex");
  // Concurrent boots: first insert wins; re-read on conflict.
  await getDb()
    .insert(appSecretsTable)
    .values({ key: SECRET_KEY, value: secret })
    .onConflictDoNothing({ target: appSecretsTable.key });
  const [after] = await getDb()
    .select({ value: appSecretsTable.value })
    .from(appSecretsTable)
    .where(eq(appSecretsTable.key, SECRET_KEY))
    .limit(1);
  cachedSecret = after?.value ?? secret;
  return cachedSecret;
}

// ---- stateless session token: base64url(userId.expiryMs.epoch).signature ----

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function issueSessionToken(
  userId: string,
  sessionEpoch: number,
): Promise<string> {
  const secret = await getSessionSecret();
  const payload = Buffer.from(
    `${userId}.${Date.now() + SESSION_TTL_MS}.${sessionEpoch}`,
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export interface VerifiedToken {
  userId: string;
  // The session epoch embedded at issue time; the caller compares it against
  // the user's current epoch to honour revocation (see principalFromSessionToken).
  epoch: number;
}

export async function verifySessionToken(
  token: string,
): Promise<VerifiedToken | null> {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const secret = await getSessionSecret();
  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, "base64url").toString();
  // Format is userId.expiry.epoch; expiry and epoch are numeric (no dots), and
  // userId is a uuid (no dots). Tokens issued before the epoch field existed
  // carry only userId.expiry and read as epoch 0 — matching the users table
  // default, so pre-upgrade sessions survive until their first password change.
  const parts = decoded.split(".");
  if (parts.length < 2) return null;
  const hasEpoch = parts.length >= 3;
  const epoch = hasEpoch ? Number(parts[parts.length - 1]) : 0;
  const expiry = Number(parts[parts.length - (hasEpoch ? 2 : 1)]);
  const userId = parts.slice(0, parts.length - (hasEpoch ? 2 : 1)).join(".");
  if (!userId) return null;
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  if (!Number.isFinite(epoch)) return null;
  return { userId, epoch };
}

// ---- credential check ----

export async function authenticate(
  email: string,
  password: string,
): Promise<{
  userId: string;
  email: string;
  fullName: string | null;
  sessionEpoch: number;
} | null> {
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      passwordHash: usersTable.passwordHash,
      sessionEpoch: usersTable.sessionEpoch,
    })
    .from(usersTable)
    .where(eq(usersTable.email, normalizeEmail(email)))
    .limit(1);
  if (!user?.passwordHash) {
    // Equalise latency with the verify path (account-enumeration timing).
    await burnDecoyScrypt(password);
    return null;
  }
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    sessionEpoch: user.sessionEpoch,
  };
}

// The user's current session epoch, for the token-revocation check on every
// authenticated request. Returns null if the user no longer exists.
export async function currentSessionEpoch(
  userId: string,
): Promise<number | null> {
  const [row] = await getDb()
    .select({ epoch: usersTable.sessionEpoch })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.epoch ?? null;
}
