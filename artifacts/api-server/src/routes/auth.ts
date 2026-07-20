import { Router, type IRouter } from "express";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, membershipsTable, usersTable } from "@workspace/db";
import {
  LoginBody,
  LoginResponse,
  ChangePasswordBody,
  AcceptInviteBody,
  ResetPasswordBody,
  TotpChallengeBody,
  TotpChallengeResponse,
  GetTotpStatusResponse,
  SetupTotpResponse,
  ActivateTotpBody,
  ActivateTotpResponse,
  DisableTotpBody,
  DisableTotpResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { DomainError } from "../modules/errors";
import { ROLE_CAPABILITIES } from "../modules/auth/rbac";
import {
  SESSION_COOKIE,
  authenticate,
  issueSessionToken,
  hashPassword,
  verifyPassword,
} from "../modules/auth/session";
import {
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  issueMfaToken,
  verifyMfaToken,
  verifyTotpCode,
} from "../modules/auth/totp";
import {
  isLoginThrottled,
  recordLoginFailure,
  clearLoginFailures,
  isActionThrottled,
  recordActionFailure,
  clearActionFailures,
  throttleActionAttempt,
} from "../modules/auth/throttle";
import { acceptInvitation } from "../modules/auth/invitations";
import { resetPassword } from "../modules/auth/password-reset";
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

// Optional TOTP enforcement for locked-down deployments, dark by default.
// When TOTP_REQUIRED_ROLES is set (comma-separated role list, e.g.
// "operator,firm_admin"), a matching-role account WITHOUT TOTP enrolment is
// refused at login with a distinct 403 TOTP_REQUIRED. Chicken-and-egg, stated
// plainly: enrolment itself requires a signed-in session, so an unenrolled
// user cannot self-enrol while their role is listed — this flag is for
// deployments that have ALREADY completed enrolment (set it after the rollout,
// or clear it temporarily / use an operator-assisted flow to onboard a new
// account). Unset env = zero behaviour change.
function totpRequiredRoles(): Set<string> {
  return new Set(
    (process.env.TOTP_REQUIRED_ROLES ?? "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean),
  );
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
  // The enrolment requirement is judged against EVERY membership, not just the
  // one this response happens to surface: the effective role is chosen
  // per-request (x-firm-id), so a user who ALSO holds a listed role elsewhere
  // must not earn a session through a benign first membership and then operate
  // under the listed role unchallenged.
  const requiredRoles = totpRequiredRoles();
  if (
    !result.totpEnabledAt &&
    memberships.some((m) => requiredRoles.has(m.role))
  ) {
    res.status(403).json({
      code: "TOTP_REQUIRED",
      error:
        "This deployment requires two-factor authentication for your role. " +
        "Enrol an authenticator app before signing in.",
    });
    return;
  }
  if (result.totpEnabledAt) {
    // TOTP-enrolled account: the password alone earns no session — no cookie,
    // no bearer token (mobile included). The short-lived mfaToken is only the
    // right to attempt /auth/totp/challenge, which issues the real session.
    // auth.login is NOT audited here; the completed challenge is the audited
    // sign-in event.
    const mfaToken = await issueMfaToken(result.userId, result.sessionEpoch);
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
        mfaRequired: true,
        mfaToken,
      }),
    );
    return;
  }
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

// Redeem a login mfaToken plus a TOTP or recovery code for the real session.
// Public (PUBLIC_PATHS): the caller by definition has no session yet — the
// signed, 5-minute mfaToken IS the credential, exactly the accept-invite
// posture. Every failure mode (bad token, stale epoch, unenrolled account,
// wrong code, replayed code) is a uniform 401 so the endpoint is not an
// oracle for which stage failed. Code guessing is capped by the action
// limiter's atomic bump-first gate (raw-pool counters that survive this
// route's 4xx rollback): the attempt is counted BEFORE the code is examined,
// so a concurrent burst cannot slip past a separately-read counter.
router.post("/auth/totp/challenge", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(TotpChallengeBody, req.body);
  const unauthorized = () => {
    res.status(401).json({ error: "Invalid sign-in challenge or code" });
  };
  const verified = await verifyMfaToken(parsed.mfaToken);
  if (!verified) {
    unauthorized();
    return;
  }
  const throttleKey = `totp:${verified.userId}`;
  // Guess cap, bump-FIRST: this public route is exempt from the global rate
  // limiter, and a check-then-record pair would let a concurrent burst of
  // guesses all pass the read before any failure landed (TOCTOU). The attempt
  // is counted atomically and refused on the post-increment count; a
  // successful challenge clears the key below, so counting attempts (not just
  // failures) never throttles a legitimate sign-in.
  const retryAfter = await throttleActionAttempt(throttleKey);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      fullName: usersTable.fullName,
      sessionEpoch: usersTable.sessionEpoch,
      totpSecret: usersTable.totpSecret,
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
      totpLastUsedStep: usersTable.totpLastUsedStep,
    })
    .from(usersTable)
    .where(eq(usersTable.id, verified.userId))
    .limit(1);
  if (
    !user ||
    // Epoch check mirrors the session parser: a password change between login
    // and challenge revokes the pending token too (SEC-02).
    verified.epoch < user.sessionEpoch ||
    !user.totpEnabledAt ||
    !user.totpSecret
  ) {
    unauthorized();
    return;
  }
  // A current TOTP code first; failing that, a one-time recovery code.
  const totpMatch = verifyTotpCode(user.totpSecret, parsed.code, {
    lastUsedStep: user.totpLastUsedStep,
  });
  let usedRecoveryCode = false;
  if (totpMatch) {
    // Single-use within the window (RFC 6238 §5.2): persist the accepted step
    // so an observed code cannot be replayed while it is still "current".
    // Compare-and-set, not a plain write: the WHERE re-asserts at write time
    // that the step is still fresh, so two concurrent redemptions of the same
    // code (both of which passed the read above) cannot both succeed — the
    // loser matches zero rows and gets the same uniform 401 as a wrong code,
    // with its attempt already counted by the bump-first gate above.
    const claimed = await getDb()
      .update(usersTable)
      .set({ totpLastUsedStep: totpMatch.step })
      .where(
        and(
          eq(usersTable.id, user.id),
          or(
            isNull(usersTable.totpLastUsedStep),
            lt(usersTable.totpLastUsedStep, totpMatch.step),
          ),
        ),
      )
      .returning({ id: usersTable.id });
    if (claimed.length === 0) {
      unauthorized();
      return;
    }
  } else {
    // Burn the code: a recovery code redeems exactly once. Presence check and
    // removal are ONE statement — `@>` asserts the hash is still in the jsonb
    // array at write time and `- text` removes it — so a concurrently-burned
    // (or plain wrong) code matches zero rows and 401s; the read-includes-
    // then-filtered-write shape had the same double-redeem race as the step
    // pin. A NULL column never satisfies `@>`, so unenrolled states refuse too.
    const codeHash = hashRecoveryCode(parsed.code);
    const burned = await getDb()
      .update(usersTable)
      .set({
        totpRecoveryCodes: sql`${usersTable.totpRecoveryCodes} - ${codeHash}::text`,
      })
      .where(
        and(
          eq(usersTable.id, user.id),
          sql`${usersTable.totpRecoveryCodes} @> to_jsonb(array[${codeHash}::text])`,
        ),
      )
      .returning({ id: usersTable.id });
    if (burned.length === 0) {
      unauthorized();
      return;
    }
    usedRecoveryCode = true;
  }
  await clearActionFailures(throttleKey);
  const memberships = await getDb()
    .select({
      firmId: membershipsTable.firmId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      buyerPartyId: membershipsTable.buyerPartyId,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  if (memberships.length === 0) {
    res.status(401).json({ error: "Account has no active membership" });
    return;
  }
  const membership = memberships[0];
  // From here this is exactly the login success path: cookie for browsers,
  // bearer token in the body only for the self-identified mobile client.
  const token = await issueSessionToken(user.id, user.sessionEpoch);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  const isMobileClient = req.get("x-meridian-client") === "mobile";
  await appendAudit({
    actorId: user.id,
    firmId: membership.firmId,
    action: "auth.totp.challenge",
    entityType: "user",
    entityId: user.id,
    after: {
      role: membership.role,
      method: usedRecoveryCode ? "recovery_code" : "totp",
    },
  });
  res.json(
    TotpChallengeResponse.parse({
      userId: user.id,
      role: membership.role,
      email: user.email,
      fullName: user.fullName,
      firmId: membership.firmId,
      clientPartyId: membership.clientPartyId,
      buyerPartyId: membership.buyerPartyId,
      capabilities: ROLE_CAPABILITIES[membership.role] ?? [],
      ...(isMobileClient ? { token } : {}),
    }),
  );
});

// Begin TOTP enrolment (authenticated). Stores the secret in the PENDING state
// (totpEnabledAt null — login behaviour unchanged until activation) and
// returns the secret, otpauth URI and recovery codes exactly once; only the
// recovery codes' sha256 hashes persist. Re-running setup while still pending
// simply rotates the pending material; once enabled it is a 409 — disable
// first (which demands password + code), so a hijacked session cannot swap
// the victim's authenticator.
router.post("/auth/totp/setup", async (req, res): Promise<void> => {
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      email: usersTable.email,
      totpEnabledAt: usersTable.totpEnabledAt,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.principal.userId))
    .limit(1);
  if (!user) {
    throw new DomainError("NOT_FOUND", "Account not found", 404);
  }
  if (user.totpEnabledAt) {
    throw new DomainError(
      "TOTP_ALREADY_ENABLED",
      "Two-factor authentication is already enabled. Disable it before re-enrolling.",
      409,
    );
  }
  const secret = generateTotpSecret();
  const { codes, hashes } = generateRecoveryCodes();
  await getDb()
    .update(usersTable)
    .set({
      totpSecret: secret,
      totpEnabledAt: null,
      totpRecoveryCodes: hashes,
      totpLastUsedStep: null,
    })
    .where(eq(usersTable.id, user.id));
  res.json(
    SetupTotpResponse.parse({
      secret,
      otpauthUri: buildOtpauthUri(user.email, secret),
      recoveryCodes: codes,
    }),
  );
});

// Confirm enrolment with a live code from the authenticator (authenticated).
// Only now does login start demanding the second factor. Like change-password,
// the session epoch is bumped — any other outstanding session (a possible
// hijacker included) is revoked at the moment the account hardens — and the
// caller's own cookie is re-issued under the new epoch.
router.post("/auth/totp/activate", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(ActivateTotpBody, req.body);
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      sessionEpoch: usersTable.sessionEpoch,
      totpSecret: usersTable.totpSecret,
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.principal.userId))
    .limit(1);
  if (!user || !user.totpSecret || user.totpEnabledAt) {
    throw new DomainError(
      "TOTP_NOT_PENDING",
      "No pending TOTP enrolment to activate. Call setup first.",
      400,
    );
  }
  const match = verifyTotpCode(user.totpSecret, parsed.code);
  if (!match) {
    throw new DomainError(
      "TOTP_INVALID_CODE",
      "That code did not match. Check the authenticator app and try again.",
      400,
    );
  }
  const enabledAt = new Date();
  const nextEpoch = user.sessionEpoch + 1;
  // Same CAS discipline as the challenge's step pin: activation only lands on
  // a still-PENDING enrolment whose step pin this code still beats, so two
  // concurrent activations (or an activation racing a challenge) cannot both
  // claim the same code / both bump the epoch. The loser matches zero rows
  // and gets the not-pending answer — accurate once the winner has committed.
  const activated = await getDb()
    .update(usersTable)
    .set({
      totpEnabledAt: enabledAt,
      // The activation code is spent: it cannot be replayed at the challenge
      // endpoint within its own validity window.
      totpLastUsedStep: match.step,
      sessionEpoch: nextEpoch,
    })
    .where(
      and(
        eq(usersTable.id, user.id),
        isNull(usersTable.totpEnabledAt),
        or(
          isNull(usersTable.totpLastUsedStep),
          lt(usersTable.totpLastUsedStep, match.step),
        ),
      ),
    )
    .returning({ id: usersTable.id });
  if (activated.length === 0) {
    throw new DomainError(
      "TOTP_NOT_PENDING",
      "No pending TOTP enrolment to activate. Call setup first.",
      400,
    );
  }
  await appendAudit({
    actorId: user.id,
    firmId: req.principal.firmId,
    action: "auth.totp.activate",
    entityType: "user",
    entityId: user.id,
    after: { totpEnabled: true, sessionsRevoked: true },
  });
  const token = await issueSessionToken(user.id, nextEpoch);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  res.json(
    ActivateTotpResponse.parse({
      enabled: true,
      enabledAt: enabledAt.toISOString(),
      recoveryCodesRemaining: (user.totpRecoveryCodes ?? []).length,
    }),
  );
});

// Disable TOTP (authenticated). Demands the account password AND a live code
// (or a recovery code): a stolen session cookie alone must not be enough to
// strip the second factor. Same throttle as the challenge — this is a
// credential check. Clears all enrolment state, bumps the epoch (revoking
// every other session) and re-issues the caller's cookie.
router.post("/auth/totp/disable", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(DisableTotpBody, req.body);
  const throttleKey = `totp:${req.principal.userId}`;
  const retryAfter = await isActionThrottled(throttleKey);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
    return;
  }
  const [user] = await getDb()
    .select({
      id: usersTable.id,
      passwordHash: usersTable.passwordHash,
      sessionEpoch: usersTable.sessionEpoch,
      totpSecret: usersTable.totpSecret,
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
      totpLastUsedStep: usersTable.totpLastUsedStep,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.principal.userId))
    .limit(1);
  if (!user || !user.totpEnabledAt || !user.totpSecret) {
    throw new DomainError(
      "TOTP_NOT_ENABLED",
      "Two-factor authentication is not enabled on this account.",
      400,
    );
  }
  const passwordOk = Boolean(
    user.passwordHash &&
      (await verifyPassword(parsed.password, user.passwordHash)),
  );
  const totpMatch = verifyTotpCode(user.totpSecret, parsed.code, {
    lastUsedStep: user.totpLastUsedStep,
  });
  const recoveryOk =
    !totpMatch &&
    (user.totpRecoveryCodes ?? []).includes(hashRecoveryCode(parsed.code));
  if (!passwordOk || (!totpMatch && !recoveryOk)) {
    await recordActionFailure(throttleKey);
    // Uniform: never say which of the two factors failed.
    res.status(401).json({ error: "Invalid password or code" });
    return;
  }
  await clearActionFailures(throttleKey);
  const nextEpoch = user.sessionEpoch + 1;
  await getDb()
    .update(usersTable)
    .set({
      totpSecret: null,
      totpEnabledAt: null,
      totpRecoveryCodes: null,
      totpLastUsedStep: null,
      sessionEpoch: nextEpoch,
    })
    .where(eq(usersTable.id, user.id));
  await appendAudit({
    actorId: user.id,
    firmId: req.principal.firmId,
    action: "auth.totp.disable",
    entityType: "user",
    entityId: user.id,
    after: { totpEnabled: false, sessionsRevoked: true },
  });
  const token = await issueSessionToken(user.id, nextEpoch);
  res.cookie(SESSION_COOKIE, token, cookieOptions(req));
  res.json(
    DisableTotpResponse.parse({
      enabled: false,
      enabledAt: null,
      recoveryCodesRemaining: null,
    }),
  );
});

// Enrolment state for the signed-in account (settings surfaces). Never returns
// the secret; the remaining-recovery-code count lets the UI nudge a user who
// has burned most of them.
router.get("/auth/totp/status", async (req, res): Promise<void> => {
  const [user] = await getDb()
    .select({
      totpEnabledAt: usersTable.totpEnabledAt,
      totpRecoveryCodes: usersTable.totpRecoveryCodes,
    })
    .from(usersTable)
    .where(eq(usersTable.id, req.principal.userId))
    .limit(1);
  const enabled = Boolean(user?.totpEnabledAt);
  res.json(
    GetTotpStatusResponse.parse({
      enabled,
      enabledAt: user?.totpEnabledAt ? user.totpEnabledAt.toISOString() : null,
      recoveryCodesRemaining: enabled
        ? (user?.totpRecoveryCodes ?? []).length
        : null,
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
  // The current-password check is a credential check, so it gets the same
  // online-guessing cap as login (raw-pool counters that survive the 401's
  // transaction rollback) — a stolen session cookie must not be upgradeable
  // to the password by unbounded guessing.
  const throttleKey = `chpw:${req.principal.userId}`;
  const retryAfter = await isActionThrottled(throttleKey);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error: `Too many attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
    });
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
    !(await verifyPassword(parsed.currentPassword, user.passwordHash))
  ) {
    await recordActionFailure(throttleKey);
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  await clearActionFailures(throttleKey);
  const nextEpoch = user.sessionEpoch + 1;
  await getDb()
    .update(usersTable)
    .set({
      passwordHash: await hashPassword(parsed.newPassword),
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

// Public like accept-invite: the single-use reset token is the credential
// (IDN-02). Uniform 400s never disclose why a token is unusable.
router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(ResetPasswordBody, req.body);
  await resetPassword(parsed.token, parsed.password);
  res.sendStatus(204);
});

export default router;
