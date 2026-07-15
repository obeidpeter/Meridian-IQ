import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, membershipsTable, usersTable } from "@workspace/db";
import {
  LoginBody,
  LoginResponse,
  ChangePasswordBody,
  AcceptInviteBody,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac";
import {
  SESSION_COOKIE,
  authenticate,
  issueSessionToken,
  hashPassword,
  verifyPassword,
} from "../modules/auth/session";
import {
  isLoginThrottled,
  recordLoginFailure,
  clearLoginFailures,
} from "../modules/auth/throttle";
import { acceptInvitation } from "../modules/auth/invitations";
import { appendAudit } from "../modules/audit/audit";

// First-party session sign-in (SEC-02). Sets an HttpOnly, SameSite=Lax cookie;
// the principal middleware resolves it on subsequent requests. Login/logout
// are on the PUBLIC_PATHS allowlist (login must work unauthenticated; logout
// must work even with an expired session); change-password is authenticated.

const router: IRouter = Router();

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
  const parsed = parseOrThrow(LoginBody, req.body);
  const retryAfter = await isLoginThrottled(req, parsed.email);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `Too many sign-in attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }
  const result = await authenticate(parsed.email, parsed.password);
  if (!result) {
    await recordLoginFailure(req, parsed.email);
    // Uniform message: never reveal whether the email exists.
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  await clearLoginFailures(req, parsed.email);
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
  const parsed = parseOrThrow(ChangePasswordBody, req.body);
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
    !verifyPassword(parsed.currentPassword, user.passwordHash)
  ) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const nextEpoch = user.sessionEpoch + 1;
  await getDb()
    .update(usersTable)
    .set({
      passwordHash: hashPassword(parsed.newPassword),
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

// Redeem an invitation (IDN-01). Public: the unguessable token IS the
// credential, so this is on the PUBLIC_PATHS allowlist and runs unauthenticated
// (in the RLS-bypass context the invitations policy grants). It creates the
// user + firm membership and consumes the invite; the invitee then signs in
// with the password they just set. The module throws a DomainError (400 invalid
// /expired, 409 email-in-use) which the error boundary maps — and, per the
// 4xx-rollback rule, any error rolls the account creation back with the invite
// left intact.
router.post("/auth/accept-invite", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(AcceptInviteBody, req.body);
  await acceptInvitation({
    token: parsed.token,
    password: parsed.password,
    fullName: parsed.fullName ?? null,
  });
  res.sendStatus(204);
});

export default router;
