import type { Request, Response, NextFunction } from "express";
import type { Role } from "@workspace/db";
import type { Principal } from "../modules/auth/rbac";

// Principal resolution. In production this MUST be populated from a verified
// Clerk session (downstream task wires Clerk). Until Clerk is wired, a
// dev-header principal keeps the RBAC + tenant-isolation contract exercisable
// without a frontend:
//   x-mock-user, x-mock-role, x-mock-firm, x-mock-client-party
// Security: the client-supplied header path is ONLY honoured outside
// production, and it never defaults to a privileged role — callers must assert
// an explicit valid role. In production, with no verified-session provider
// wired yet, non-public requests are rejected rather than trusted.

const VALID_ROLES: Role[] = [
  "firm_admin",
  "firm_staff",
  "client_user",
  "operator",
  "bank_user",
  "auditor",
];

// Routes reachable without a principal (health probe + public stamp
// verification, which any buyer/bank/auditor may call).
const PUBLIC_PATHS = new Set(["/api/healthz", "/api/verify-stamp"]);

const IS_PRODUCTION = process.env.NODE_ENV === "production";

function header(req: Request, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
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
  if (IS_PRODUCTION) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const roleHeader = header(req, "x-mock-role");
  if (!roleHeader || !(VALID_ROLES as string[]).includes(roleHeader)) {
    res
      .status(401)
      .json({ error: "Missing or invalid x-mock-role dev principal header" });
    return;
  }
  const principal: Principal = {
    userId: header(req, "x-mock-user") ?? "dev-user",
    role: roleHeader as Role,
    firmId: header(req, "x-mock-firm"),
    clientPartyId: header(req, "x-mock-client-party"),
  };
  req.principal = principal;
  next();
}
