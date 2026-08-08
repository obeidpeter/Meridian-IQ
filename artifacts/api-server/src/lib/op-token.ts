import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

// Opt-in shared-secret guard for the operational endpoints (/api/metrics,
// /api/internal/sweep). Both are deliberately on PUBLIC_PATHS so schedulers
// and scrapers can reach them without a session. Sweep is fail-closed and
// requires SWEEP_TOKEN; metrics remains optionally protected for platform
// scrapers. Callers present configured secrets only in `x-op-token`.
// Secrets are never accepted in URLs, where browser history, proxy logs and
// referrers can retain them.

/**
 * The secret as the caller presented it. Header-only by design.
 */
export function presentedOpToken(req: Request): string | undefined {
  return req.get("x-op-token") ?? undefined;
}

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
export function requireOpToken(
  envName: string,
  opts: { required?: boolean } = {},
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const expected = process.env[envName];
    if (!expected && opts.required) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const presented = presentedOpToken(req);
    if (opTokenAllows(expected, presented)) {
      next();
      return;
    }
    res.status(401).json({ error: "Invalid or missing operational token" });
  };
}
