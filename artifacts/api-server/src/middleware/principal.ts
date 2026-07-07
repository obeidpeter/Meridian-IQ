import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { getDb, usersTable, membershipsTable, type Role } from "@workspace/db";
import type { Principal } from "../modules/auth/rbac";
import { SESSION_COOKIE, verifySessionToken } from "../modules/auth/session";

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

// Routes reachable without a principal (health probe, public stamp
// verification, subdomain branding resolution — the white-label shell needs
// its theme before any login — and the session endpoints themselves).
const PUBLIC_PATHS = new Set([
  "/api/healthz",
  "/api/verify-stamp",
  "/api/public/theme",
  "/api/auth/login",
  "/api/auth/logout",
]);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
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

  const memberships = await getDb()
    .select({
      firmId: membershipsTable.firmId,
      role: membershipsTable.role,
      clientPartyId: membershipsTable.clientPartyId,
      buyerPartyId: membershipsTable.buyerPartyId,
    })
    .from(membershipsTable)
    .where(eq(membershipsTable.userId, user.id));
  if (memberships.length === 0) return null;

  const requestedFirm = header(req, "x-firm-id");
  const membership = requestedFirm
    ? memberships.find((m) => m.firmId === requestedFirm)
    : memberships[0];
  if (!membership) return null;

  return {
    userId: user.id,
    role: membership.role,
    firmId: membership.firmId,
    clientPartyId: membership.clientPartyId,
    buyerPartyId: membership.buyerPartyId,
  };
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
  const userId = await verifySessionToken(token);
  if (!userId) return null;
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

export function resolvePrincipal(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (PUBLIC_PATHS.has(req.path)) {
    next();
    return;
  }
  // Resolution order: explicit dev headers (never honoured in production) win
  // for tests and tooling; then the first-party session cookie; then a
  // Clerk-verified session in production.
  const resolve = (async (): Promise<Principal | null> => {
    if (!IS_PRODUCTION) {
      const dev = resolveDevPrincipal(req);
      if (dev) return dev;
    }
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
