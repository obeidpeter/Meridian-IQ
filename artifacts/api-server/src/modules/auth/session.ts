import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
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

// ---- password hashing (scrypt, salt:hash hex) ----

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
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

// ---- stateless session token: base64url(userId.expiryMs).signature ----

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export async function issueSessionToken(userId: string): Promise<string> {
  const secret = await getSessionSecret();
  const payload = Buffer.from(
    `${userId}.${Date.now() + SESSION_TTL_MS}`,
  ).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export async function verifySessionToken(
  token: string,
): Promise<string | null> {
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
  const sep = decoded.lastIndexOf(".");
  if (sep <= 0) return null;
  const userId = decoded.slice(0, sep);
  const expiry = Number(decoded.slice(sep + 1));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null;
  return userId;
}

// ---- credential check ----

export async function authenticate(
  email: string,
  password: string,
): Promise<{ userId: string; email: string; fullName: string | null } | null> {
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      passwordHash: usersTable.passwordHash,
    })
    .from(usersTable)
    .where(eq(usersTable.email, email.trim().toLowerCase()))
    .limit(1);
  if (!user?.passwordHash) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return { userId: user.id, email: user.email, fullName: user.fullName };
}
