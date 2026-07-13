import { Router, type IRouter, type Request } from "express";
import { eq } from "drizzle-orm";
import { getDb, membershipsTable, usersTable } from "@workspace/db";
import {
  LoginBody,
  LoginResponse,
  ChangePasswordBody,
} from "@workspace/api-zod";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac";
import {
  SESSION_COOKIE,
  authenticate,
  issueSessionToken,
  hashPassword,
  verifyPassword,
} from "../modules/auth/session";
import { appendAudit } from "../modules/audit/audit";

// First-party session sign-in (SEC-02). Sets an HttpOnly, SameSite=Lax cookie;
// the principal middleware resolves it on subsequent requests. Login/logout
// are on the PUBLIC_PATHS allowlist (login must work unauthenticated; logout
// must work even with an expired session); change-password is authenticated.

const router: IRouter = Router();

// ---- login throttling (SEC-02) ----------------------------------------------
// In-memory fixed-window backoff. Two independent counters, both of which must
// pass, suit the single-process modular monolith (a multi-instance deployment
// would move them to shared storage):
//   1. per email+IP — a tight 5/15-min cap that stops probing from one source.
//   2. per email — a looser account-scoped cap (50/hour) that a distributed
//      credential-stuffing run (many source IPs) cannot evade, since it does
//      not include the IP in the key. Deliberately looser so a bystander
//      attacker cannot cheaply lock a victim out (availability), while still
//      capping aggregate online guesses against one account.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const ACCOUNT_MAX_FAILURES = 50;
// Hard cap on distinct throttle keys held in memory. With req.ip now trustworthy
// (app.set("trust proxy") in app.ts), an attacker can no longer mint unbounded
// keys by spoofing X-Forwarded-For, so this is a backstop rather than the
// primary defence (SEC-M4).
const LOGIN_MAX_KEYS = 10_000;
const failures = new Map<string, { count: number; windowStart: number }>();
const accountFailures = new Map<string, { count: number; windowStart: number }>();

function throttleKey(req: Request, email: string): string {
  // req.ip is derived from the trusted-proxy hop count (app.set("trust proxy")),
  // so it reflects the real client address and cannot be spoofed by a
  // client-supplied X-Forwarded-For header (SEC-M4).
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return `${email.trim().toLowerCase()}|${ip}`;
}

function accountKey(email: string): string {
  return email.trim().toLowerCase();
}

// Seconds to wait if `key` in `map` is over `max` within `windowMs`, else null.
function windowRetryAfter(
  map: Map<string, { count: number; windowStart: number }>,
  key: string,
  windowMs: number,
  max: number,
): number | null {
  const entry = map.get(key);
  if (!entry) return null;
  const elapsed = Date.now() - entry.windowStart;
  if (elapsed > windowMs) {
    map.delete(key);
    return null;
  }
  if (entry.count >= max) return Math.ceil((windowMs - elapsed) / 1000);
  return null;
}

function isThrottled(req: Request, email: string): number | null {
  return (
    windowRetryAfter(failures, throttleKey(req, email), LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES) ??
    windowRetryAfter(accountFailures, accountKey(email), ACCOUNT_WINDOW_MS, ACCOUNT_MAX_FAILURES)
  );
}

function bump(
  map: Map<string, { count: number; windowStart: number }>,
  key: string,
  windowMs: number,
): void {
  const now = Date.now();
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
  } else {
    entry.count += 1;
  }
  // Opportunistic pruning keeps the map bounded without a timer: evict expired
  // windows first, then — if still over the cap — the oldest-inserted entries
  // (Map preserves insertion order), so memory stays bounded under churn.
  if (map.size > LOGIN_MAX_KEYS) {
    for (const [k, v] of map) {
      if (now - v.windowStart > windowMs) map.delete(k);
    }
    while (map.size > LOGIN_MAX_KEYS) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

function recordFailure(req: Request, email: string): void {
  bump(failures, throttleKey(req, email), LOGIN_WINDOW_MS);
  bump(accountFailures, accountKey(email), ACCOUNT_WINDOW_MS);
}

function clearFailures(req: Request, email: string): void {
  failures.delete(throttleKey(req, email));
  accountFailures.delete(accountKey(email));
}

function cookieOptions(req: { secure?: boolean; headers: Record<string, unknown> }) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "");
  const secure = Boolean(req.secure) || forwardedProto.includes("https");
  // The web apps are served inside a cross-site iframe (the Replit preview and
  // any other embed), so the session cookie must be SameSite=None to be sent
  // back on subsequent API calls. SameSite=None requires Secure; fall back to
  // Lax on plain http (e.g. a direct localhost hit) where None+Secure would be
  // rejected by the browser.
  return {
    httpOnly: true,
    sameSite: (secure ? "none" : "lax") as "none" | "lax",
    path: "/",
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const retryAfter = isThrottled(req, parsed.data.email);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }
  const result = await authenticate(parsed.data.email, parsed.data.password);
  if (!result) {
    recordFailure(req, parsed.data.email);
    // Uniform message: never reveal whether the email exists.
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  clearFailures(req, parsed.data.email);
  const memberships = await getDb()
    .select({
      firmId: membershipsTable.firmId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      buyerPartyId: membershipsTable.buyerPartyId,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, result.userId));
  if (memberships.length === 0) {
    res.status(401).json({ error: "Account has no active membership" });
    return;
  }
  const membership = memberships[0];
  const token = await issueSessionToken(result.userId, result.sessionEpoch);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  // Only native/mobile clients (which cannot use HttpOnly cookies) receive the
  // bearer token in the response body; they identify themselves with the
  // X-Meridian-Client header. Browser apps stay cookie-only so an XSS cannot
  // read a replayable session token out of the login response (SEC-02).
  const isMobileClient = req.get("x-meridian-client") === "mobile";
  await appendAudit({
    actorId: result.userId,
    firmId: membership.firmId,
    action: "auth.login",
    entityType: "user",
    entityId: result.userId,
    after: { role: membership.role },
  });
  res.json(
    LoginResponse.parse({
      userId: result.userId,
      role: membership.role,
      email: result.email,
      fullName: result.fullName,
      firmId: membership.firmId,
      clientPartyId: membership.clientPartyId,
      buyerPartyId: membership.buyerPartyId,
      capabilities: ROLE_CAPABILITIES[membership.role] ?? [],
      // Same signed session token as the cookie, for native mobile clients
      // that cannot use HttpOnly cookies (sent as Authorization: Bearer).
      ...(isMobileClient ? { token } : {}),
    }),
  );
});

router.post("/auth/logout", (req, res): void => {
  // Clear with the same attributes the cookie was set with so the browser
  // matches and deletes it in the cross-site iframe context.
  const { maxAge: _maxAge, ...clearOpts } = cookieOptions(req);
  res.clearCookie(SESSION_COOKIE, clearOpts);
  res.sendStatus(204);
});

// Authenticated password change (SEC-02). Requires the current password —
// possession of a session cookie alone must not be enough to take over the
// account. Bumping session_epoch invalidates every previously-issued token
// (they carry the old epoch), so a stolen token stops working the instant the
// victim rotates their password; the current device is kept signed in by
// re-issuing its token with the new epoch. The audit event records the rotation.
router.post("/auth/change-password", async (req, res): Promise<void> => {
  const parsed = ChangePasswordBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      passwordHash: usersTable.passwordHash,
      sessionEpoch: usersTable.sessionEpoch,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.principal.userId))
    .limit(1);
  if (
    !user?.passwordHash ||
    !verifyPassword(parsed.data.currentPassword, user.passwordHash)
  ) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const nextEpoch = user.sessionEpoch + 1;
  await getDb()
    .update(usersTable)
    .set({
      passwordHash: hashPassword(parsed.data.newPassword),
      sessionEpoch: nextEpoch,
    })
    .where(eq(usersTable.id, user.id));
  await appendAudit({
    actorId: user.id,
    firmId: req.principal.firmId,
    action: "auth.password_change",
    entityType: "user",
    entityId: user.id,
    after: { rotated: true, sessionsRevoked: true },
  });
  // Keep the caller's current (browser) session alive under the new epoch so a
  // routine password change does not log the user out of the device they
  // changed it on; every OTHER outstanding token is now stale. The mobile app
  // does not expose this endpoint, so a bearer-token caller (rare) simply
  // re-authenticates — the contract response stays 204.
  const token = await issueSessionToken(user.id, nextEpoch);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  res.sendStatus(204);
});

export default router;
