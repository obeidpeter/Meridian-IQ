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
// HMAC-signed session token in an HttpOnly cookie. Production signing keys
// come from the deployment secret store and support
// rotation; only development falls back to a database-persisted key.

export const SESSION_COOKIE = "miq_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_KEY = "session_hmac_secret";

// Historical demonstration identities must never authenticate in production,
// even if a copied development database still contains their old password
// hashes. This code-level wall is immediate; startup also removes the hashes
// and bumps their session epochs so already-issued tokens stop resolving.
export const PRODUCTION_DEMO_EMAILS = [
  "owner@adaezefoods.example",
  "demo.staff@meridianiq.example",
  "demo.admin@meridianiq.example",
  "ops@meridianiq.example",
  "finance@zenithretail.example",
  "accounts@saharalogistics.example",
  "audit@meridianiq.example",
  "claims.approver@meridianiq.example",
] as const;
const PRODUCTION_DEMO_EMAIL_SET = new Set<string>(PRODUCTION_DEMO_EMAILS);

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
const rawScrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

export class PasswordKdfBusyError extends Error {
  constructor() {
    super("Password verification capacity is temporarily full");
    this.name = "PasswordKdfBusyError";
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  max: number,
) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

const KDF_CONCURRENCY = boundedInteger(
  process.env.PASSWORD_KDF_CONCURRENCY,
  4,
  16,
);
const KDF_MAX_QUEUE = Math.max(
  KDF_CONCURRENCY,
  boundedInteger(process.env.PASSWORD_KDF_MAX_QUEUE, 32, 256),
);
const KDF_QUEUE_TIMEOUT_MS = 5_000;
let activeKdfs = 0;
const kdfWaiters: Array<{
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}> = [];

function releaseKdfSlot(): void {
  activeKdfs--;
  const waiter = kdfWaiters.shift();
  if (!waiter) return;
  clearTimeout(waiter.timer);
  activeKdfs++;
  waiter.resolve(releaseKdfSlot);
}

function acquireKdfSlot(): Promise<() => void> {
  if (activeKdfs < KDF_CONCURRENCY) {
    activeKdfs++;
    return Promise.resolve(releaseKdfSlot);
  }
  if (kdfWaiters.length >= KDF_MAX_QUEUE) {
    return Promise.reject(new PasswordKdfBusyError());
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = kdfWaiters.indexOf(waiter);
        if (index >= 0) kdfWaiters.splice(index, 1);
        reject(new PasswordKdfBusyError());
      }, KDF_QUEUE_TIMEOUT_MS),
    };
    waiter.timer.unref();
    kdfWaiters.push(waiter);
  });
}

async function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
): Promise<Buffer> {
  const release = await acquireKdfSlot();
  try {
    return await rawScrypt(password, salt, keylen);
  } finally {
    release();
  }
}

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
  if (
    !/^[0-9a-f]{32}$/i.test(saltHex ?? "") ||
    !/^[0-9a-f]{64}$/i.test(hashHex ?? "")
  ) {
    return false;
  }
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
const DECOY_SALT = Buffer.from("b7e07f16d3894ad72f49e58a4d37c6f2", "hex");
const DECOY_EXPECTED = Buffer.from(
  "97909b2da01c0554d1fc221805f6072af23a02e6b2687a2968ca16e3b3093ac6",
  "hex",
);
async function burnDecoyScrypt(password: string): Promise<void> {
  const actual = await scrypt(password, DECOY_SALT, DECOY_EXPECTED.length);
  timingSafeEqual(actual, DECOY_EXPECTED);
}

// ---- signing secret (generated once, persisted) ----

let cachedDevelopmentSecret: string | null = null;

interface SessionSigningKey {
  id: string;
  secret: string;
}

function environmentSigningKeys(): SessionSigningKey[] {
  const keyRing = process.env.SESSION_SIGNING_KEYS?.trim();
  if (keyRing) {
    const keys = keyRing.split(",").map((entry) => {
      const separator = entry.indexOf(":");
      const id = entry.slice(0, separator).trim();
      const secret = entry.slice(separator + 1).trim();
      if (
        separator <= 0 ||
        !/^[A-Za-z0-9_-]{1,32}$/.test(id) ||
        secret.length < 32
      ) {
        throw new Error(
          "SESSION_SIGNING_KEYS entries must be key-id:secret with a 32+ character secret",
        );
      }
      return { id, secret };
    });
    if (new Set(keys.map((key) => key.id)).size !== keys.length) {
      throw new Error("SESSION_SIGNING_KEYS key IDs must be unique");
    }
    return keys;
  }
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) {
    if (secret.length < 32) {
      throw new Error("SESSION_SECRET must contain at least 32 characters");
    }
    return [{ id: "primary", secret }];
  }
  return [];
}

async function getSessionSigningKeys(): Promise<SessionSigningKey[]> {
  const configured = environmentSigningKeys();
  if (configured.length > 0) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Production requires SESSION_SIGNING_KEYS (preferred) or SESSION_SECRET",
    );
  }

  // Development/test fallback only. Production keys must live outside the
  // application database so a database read cannot mint sessions.
  return [
    { id: "development-db", secret: await getDevelopmentSessionSecret() },
  ];
}

async function getDevelopmentSessionSecret(): Promise<string> {
  if (cachedDevelopmentSecret) return cachedDevelopmentSecret;
  const [row] = await getDb()
    .select({ value: appSecretsTable.value })
    .from(appSecretsTable)
    .where(eq(appSecretsTable.key, SECRET_KEY))
    .limit(1);
  if (row) {
    cachedDevelopmentSecret = row.value;
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
  cachedDevelopmentSecret = after?.value ?? secret;
  return cachedDevelopmentSecret;
}

export async function getSessionSecret(): Promise<string> {
  return (await getSessionSigningKeys())[0].secret;
}

export async function assertSessionSigningConfigured(): Promise<void> {
  await getSessionSigningKeys();
}

// ---- stateless session token: base64url(userId.expiryMs.epoch).signature ----

// Shared with the mfa pending token (modules/auth/totp.ts): same HMAC and
// persisted secret, but the two payload formats are mutually unparseable
// (dots here, a colon-separated purposed payload there), so a signature valid
// for one kind can never be redeemed as the other.
export function signSessionPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

const sign = signSessionPayload;

export async function issueSessionToken(
  userId: string,
  sessionEpoch: number,
): Promise<string> {
  const [key] = await getSessionSigningKeys();
  const payload = Buffer.from(
    `${userId}.${Date.now() + SESSION_TTL_MS}.${sessionEpoch}`,
  ).toString("base64url");
  return `${key.id}.${payload}.${sign(payload, key.secret)}`;
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
  const parts = token.split(".");
  let payload: string;
  let signature: string;
  let key: SessionSigningKey | undefined;
  const keys = await getSessionSigningKeys();
  if (parts.length === 3) {
    key = keys.find((candidate) => candidate.id === parts[0]);
    payload = parts[1];
    signature = parts[2];
  } else if (parts.length === 2 && process.env.NODE_ENV !== "production") {
    // Development-only compatibility with tokens issued before key IDs were
    // introduced. Production deliberately invalidates those DB-signed tokens.
    key = keys[0];
    [payload, signature] = parts;
  } else {
    return null;
  }
  if (!key || !payload || !signature) return null;
  const expected = sign(payload, key.secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const decoded = Buffer.from(payload, "base64url").toString();
  // Format is userId.expiry.epoch; expiry and epoch are numeric (no dots), and
  // userId is a uuid (no dots). Tokens issued before the epoch field existed
  // carry only userId.expiry and read as epoch 0 — matching the users table
  // default, so pre-upgrade sessions survive until their first password change.
  const payloadParts = decoded.split(".");
  if (payloadParts.length < 2) return null;
  const hasEpoch = payloadParts.length >= 3;
  const epoch = hasEpoch ? Number(payloadParts[payloadParts.length - 1]) : 0;
  const expiry = Number(payloadParts[payloadParts.length - (hasEpoch ? 2 : 1)]);
  const userId = payloadParts
    .slice(0, payloadParts.length - (hasEpoch ? 2 : 1))
    .join(".");
  if (!userId) return null;
  if (!Number.isSafeInteger(expiry) || Date.now() > expiry) return null;
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
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
  // Non-null when the account has completed TOTP enrolment: the login route
  // must then withhold the session cookie and hand out an mfa pending token
  // instead (modules/auth/totp.ts). Returned here so login needs no second
  // user lookup after the credential check.
  totpEnabledAt: Date | null;
} | null> {
  const normalizedEmail = normalizeEmail(email);
  if (
    process.env.NODE_ENV === "production" &&
    PRODUCTION_DEMO_EMAIL_SET.has(normalizedEmail)
  ) {
    await burnDecoyScrypt(password);
    return null;
  }
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      passwordHash: usersTable.passwordHash,
      sessionEpoch: usersTable.sessionEpoch,
      totpEnabledAt: usersTable.totpEnabledAt,
    })
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail))
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
    totpEnabledAt: user.totpEnabledAt,
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
