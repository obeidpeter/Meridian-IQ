import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Opt-in shared-secret guard for the operational endpoints (/api/metrics,
// /api/internal/sweep). Both are deliberately on PUBLIC_PATHS so schedulers
// and scrapers can reach them without a session, and both stay safe to expose
// (idempotent, no tenant data) — but a deployment that wants them closed sets
// the endpoint's env var and callers must then present the secret, either as
// an `x-op-token` header (preferred) or a `?token=` query param for pingers
// that can only hit a URL. Unset env = open, so existing deployments and the
// Replit scheduler keep working untouched.

/** True when no secret is configured, or the presented value matches it. */
export function opTokenAllows(
  expected: string | undefined,
  presented: string | undefined,
): boolean {
  if (!expected) return true;
  if (!presented) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // Length equality checked first because timingSafeEqual requires it; the
  // secret's length is not something we defend.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Express guard reading the expected secret from `process.env[envName]` on
 * every request (keeps tests simple; env is static per process anyway).
 */
export function requireOpToken(envName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented =
      req.get("x-op-token") ??
      (typeof req.query.token === "string" ? req.query.token : undefined);
    if (opTokenAllows(process.env[envName], presented)) {
      next();
      return;
    }
    res.status(401).json({ error: "Invalid or missing operational token" });
  };
}
