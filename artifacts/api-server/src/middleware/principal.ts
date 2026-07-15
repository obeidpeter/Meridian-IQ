import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { getDb, usersTable, membershipsTable, type Role } from "@workspace/db";
import type { Principal } from "../modules/auth/rbac";
import {
  SESSION_COOKIE,
  verifySessionToken,
  currentSessionEpoch,
} from "../modules/auth/session";
import { logger } from "../lib/logger";

// Principal resolution.
//
// Production: identity comes from a Clerk-verified session (clerkMiddleware runs
// first; getAuth(req) yields the Clerk user id). Multi-tenancy and roles are NOT
// carried by Clerk — Replit-managed Clerk has no organization tenants — so the
// tenant (firm) and role are resolved from this platform's own membership table,
// which is the authoritative role-permission source (CON-01, SEC-02/03). A user
// with several memberships selects one with the x-firm-id header; otherwise the
// first membership is used. No verified session (or no membership) => 401.
//
// Development: a dev-header principal keeps the RBAC + tenant-isolation contract
// exercisable without a frontend to originate Clerk sessions:
//   x-mock-user, x-mock-role, x-mock-firm, x-mock-client-party, x-mock-buyer-party
// The client-supplied header path is ONLY honoured outside production and never
// defaults to a privileged role — callers must assert an explicit valid role.

const VALID_ROLES: Role[] = [
  "firm_admin",
  "firm_staff",
  "client_user",
  "operator",
  "bank_user",
  "buyer_user",
  "auditor",
];

// Routes reachable without a principal (health probe, the external sweep
// wake-up trigger — an anonymous scheduler ping, see routes/sweep.ts — public
// stamp verification, subdomain branding resolution — the white-label shell
// needs its theme before any login — and the session endpoints themselves).
const PUBLIC_PATHS = new Set([
  "/api/healthz",
  "/api/readyz",
  "/api/metrics",
  "/api/internal/sweep",
  "/api/verify-stamp",
  "/api/public/theme",
  "/api/auth/login",
  "/api/auth/logout",
  // Invitation redeem: the single-use token is the credential, so the invitee
  // has no session yet (IDN-01). Firm scoping is enforced by the token lookup.
  "/api/auth/accept-invite",
]);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

// The dev-header auth shim (x-mock-*) is a full identity bypass, so it is
// enabled ONLY when explicitly opted in, and never in production (SEC-M7).
// NODE_ENV "development"/"test" opt in by default (local dev and the CI e2e
// harness, which boots with NODE_ENV=development); anything else — including an
// UNSET or misspelled NODE_ENV — fails closed, so a misconfigured staging or
// production deployment never honours client-supplied identity headers.
const DEV_AUTH_ENABLED =
  !IS_PRODUCTION &&
  (process.env.ENABLE_DEV_AUTH === "true" ||
    process.env.NODE_ENV === "development" ||
    process.env.NODE_ENV === "test");

if (DEV_AUTH_ENABLED) {
  logger.warn(
    "Dev-header auth shim ENABLED: x-mock-* identity headers are honoured. " +
      "This is a full auth bypass and must never be enabled in production.",
  );
}

const CSRF_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_HEADER = "x-meridian-csrf";

// CSRF guard (SEC-02). The first-party session cookie is issued SameSite=None so
// it works inside the cross-site preview iframe, which means the browser also
// attaches it to cross-site requests — the classic CSRF exposure. We require a
// custom request header on state-changing, cookie-authenticated requests: the
// browser will not let a cross-site page set a custom header without a CORS
// preflight, and the API's CORS policy does not grant that preflight, so a
// forged <form>/simple request is rejected. Requests authenticated by dev
// x-mock headers, a Bearer token or Clerk carry no session cookie and cannot be
// forged cross-site, so they pass through. Public endpoints (login/logout/health
// /verify-stamp/theme) are exempt so unauthenticated and tooling calls still
// work. Must run after cookie-parser so req.cookies is populated.
export function requireCsrfHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (CSRF_SAFE_METHODS.has(req.method) || PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const hasSessionCookie = Boolean(cookies?.[SESSION_COOKIE]);
  if (!hasSessionCookie || header(req, CSRF_HEADER)) {
    next();
    return;
  }
  res
    .status(403)
    .json({ error: "Missing or invalid CSRF header" });
}

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

// Tenancy and role for a resolved platform user, from the membership table —
// the authoritative role-permission source shared by the Clerk and first-party
// session paths. A user with several memberships selects one with the
// x-firm-id header; otherwise the first membership is used. No membership (or
// an unknown x-firm-id) => null.
async function principalFromMembership(
  req: Request,
  userId: string,
): Promise<Principal | null> {
  const memberships = await getDb()
    .select({
      firmId: membershipsTable.firmId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      buyerPartyId: membershipsTable.buyerPartyId,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, userId));
  if (memberships.length === 0) return null;

  const requestedFirm = header(req, "x-firm-id");
  const membership = requestedFirm
    ? memberships.find((m) => m.firmId === requestedFirm)
    : memberships[0];
  if (!membership) return null;

  return {
    userId,
    role: membership.role,
    firmId: membership.firmId,
    clientPartyId: membership.clientPartyId,
    buyerPartyId: membership.buyerPartyId,
  };
}

// Production: map a Clerk-verified user onto a tenant-scoped principal via the
// platform membership table. Returns null when unauthenticated or unprovisioned.
async function resolveClerkPrincipal(req: Request): Promise<Principal | null> {
  const auth = getAuth(req);
  const clerkUserId = auth?.userId;
  if (!clerkUserId) return null;

  const [user] = await getDb()
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.clerkUserId, clerkUserId))
    .limit(1);
  if (!user) return null;

  return principalFromMembership(req, user.id);
}

// Development: build a principal from client headers (never trusted in prod).
function resolveDevPrincipal(req: Request): Principal | null {
  const roleHeader = header(req, "x-mock-role");
  if (!roleHeader || !(VALID_ROLES as string[]).includes(roleHeader)) {
    return null;
  }
  return {
    userId: header(req, "x-mock-user") ?? "dev-user",
    role: roleHeader as Role,
    firmId: header(req, "x-mock-firm"),
    clientPartyId: header(req, "x-mock-client-party"),
    buyerPartyId: header(req, "x-mock-buyer-party"),
  };
}

// First-party cookie session (see modules/auth/session.ts): a signed token in
// an HttpOnly cookie resolves to a platform user; tenancy and role come from
// the membership table exactly as in the Clerk path. Multi-membership users
// disambiguate with x-firm-id.
async function resolveSessionPrincipal(req: Request): Promise<Principal | null> {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    SESSION_COOKIE
  ];
  if (!token) return null;
  return principalFromSessionToken(req, token);
}

// Bearer variant of the same first-party session: native mobile clients (the
// Expo companion app) cannot rely on the HttpOnly cookie, so /auth/login also
// returns the signed session token in the response body and the app presents
// it as `Authorization: Bearer <token>`. Verification and membership
// resolution are identical to the cookie path; bearer requests carry no cookie
// so the CSRF guard already passes them through.
async function resolveBearerPrincipal(req: Request): Promise<Principal | null> {
  const authz = header(req, "authorization");
  if (!authz || !authz.toLowerCase().startsWith("bearer ")) return null;
  const token = authz.slice(7).trim();
  if (!token) return null;
  return principalFromSessionToken(req, token);
}

async function principalFromSessionToken(
  req: Request,
  token: string,
): Promise<Principal | null> {
  const verified = await verifySessionToken(token);
  if (!verified) return null;
  const { userId } = verified;
  // Session revocation (SEC-02): a token issued before the user's current
  // session epoch is stale — the epoch is bumped on password change, so tokens
  // held by an attacker stop resolving the moment the victim rotates their
  // password, instead of surviving until their 7-day expiry.
  const epoch = await currentSessionEpoch(userId);
  if (epoch === null || verified.epoch < epoch) return null;
  return principalFromMembership(req, userId);
}

export function resolvePrincipal(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  // Resolution order: explicit dev headers (only when DEV_AUTH_ENABLED — never
  // in production or a misconfigured env) win for tests and tooling; then a
  // Bearer session token (mobile); then the first-party session cookie; then a
  // Clerk-verified session in production.
  const resolve = (async (): Promise<Principal | null> => {
    if (DEV_AUTH_ENABLED) {
      const dev = resolveDevPrincipal(req);
      if (dev) return dev;
    }
    const bearer = await resolveBearerPrincipal(req);
    if (bearer) return bearer;
    const session = await resolveSessionPrincipal(req);
    if (session) return session;
    if (IS_PRODUCTION) return resolveClerkPrincipal(req);
    return null;
  })();
  resolve
    .then((principal) => {
      if (!principal) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      req.principal = principal;
      next();
    })
    .catch(next);
}
