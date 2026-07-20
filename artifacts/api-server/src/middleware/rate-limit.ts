import type { Request, Response, NextFunction } from "express";
import { pool } from "@workspace/db";
import type { Principal } from "../modules/auth/rbac";
import { PUBLIC_PATHS } from "./principal";

// Per-principal rate limiting (SEC/NFR). Mounted in app.ts BETWEEN
// resolvePrincipal and tenantContext: after principal resolution so the key
// is the authenticated user (falling back to the trusted-proxy req.ip for the
// principal-less edge), and before the per-request transaction so the counter
// bump happens outside it entirely. The bump rides the RAW pool — exactly the
// modules/auth/throttle.ts posture — because tenantContext rolls back on any
// 4xx; a count written inside the request transaction would be erased by the
// very 429 it produced.
//
// Counters reuse the login_attempts table under namespaced keys with the same
// atomic INSERT .. ON CONFLICT window-reset bump as the login throttle. Two
// fixed-window classes, both per minute:
//   GENERAL  rl:g:<userId|ip>  every non-exempt API request (default 600/min)
//   MODEL    rl:m:<userId|ip>  the model-calling routes below (default 60/min)
// Env-tunable via RATE_LIMIT_GENERAL_PER_MIN / RATE_LIMIT_MODEL_PER_MIN; 0
// disables a class. PUBLIC_PATHS are exempt — each carries its own gate (login
// throttle, op tokens, the inbound-email shared secret).
//
// Key lifetime is the 60s window — comfortably inside the existing
// login-attempts cleanup sweep's one-hour delete horizon
// (sweepExpiredLoginAttempts in modules/auth/throttle.ts), so stale rl:* rows
// are pruned by the sweep that already exists; no predicate change needed.

const WINDOW_MS = 60_000;
// Generous by design: the ceiling is for runaway scripts and abuse, not for
// humans — the e2e battery drives full journeys through single demo users and
// must never graze it.
const GENERAL_DEFAULT_PER_MIN = 600;
const MODEL_DEFAULT_PER_MIN = 60;

// The MODEL class covers every route whose handler spends model-provider
// tokens in-request (or, for /clerk/batches, queues guaranteed token spend).
// Two families, kept in lockstep with their sources of truth:
//   1. app.ts NO_CONTEXT_ROUTES / NO_CONTEXT_ROUTE_PATTERNS — the multi-second
//      provider calls exempted from the request transaction (capture, batch,
//      ask, evals/canaries, drafts, case retry). The inbound-email webhook is
//      NOT here: it is public and carries its own shared-secret gate.
//   2. The digest-posture single-completion routes that stay inside the
//      ordinary transaction (see the catalogue-draft comment in
//      routes/clerk.ts): explain-failure, draft-chaser, reconciliation-assist,
//      claims draft, both cover notes, reply drafts, narrative.
// Adding a model-calling route? Add it to the matching list here too.
export const MODEL_RATE_LIMITED_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/clerk/cases",
  "POST /api/clerk/cases/batch",
  "POST /api/clerk/batches",
  "POST /api/clerk/ask",
  "POST /api/clerk/eval/run",
  "POST /api/clerk/eval/canary",
  "POST /api/clerk/eval/model-canary",
  "POST /api/clerk/format-draft",
  "POST /api/clerk/draft-invoice",
  "POST /api/clerk/client-import-draft",
  "POST /api/clerk/catalogue-draft",
  "POST /api/clerk/claims/draft",
  "POST /api/clerk/explain-failure",
  "POST /api/clerk/draft-chaser",
  "POST /api/clerk/reconciliation-assist",
  "POST /api/vat-pack/cover-note",
  "POST /api/quarterly-review/cover-note",
]);

export const MODEL_RATE_LIMITED_ROUTE_PATTERNS: ReadonlyArray<{
  method: string;
  pattern: RegExp;
}> = [
  // Case retry re-runs a full extraction (app.ts NO_CONTEXT_ROUTE_PATTERNS).
  { method: "POST", pattern: /^\/api\/clerk\/cases\/[^/]+\/retry$/ },
  // Digest-posture drafting with an :id segment.
  { method: "POST", pattern: /^\/api\/engagements\/[^/]+\/narrative$/ },
  { method: "POST", pattern: /^\/api\/escalations\/[^/]+\/reply-draft$/ },
];

function isModelRoute(req: Request): boolean {
  return (
    MODEL_RATE_LIMITED_ROUTES.has(`${req.method} ${req.path}`) ||
    MODEL_RATE_LIMITED_ROUTE_PATTERNS.some(
      (r) => r.method === req.method && r.pattern.test(req.path),
    )
  );
}

// Parsed per request (trivially cheap) so tests — and a live operator flipping
// an env var on a restarting instance — see the current value, with no module
// state to reset.
function limitFor(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed); // 0 = class disabled
}

// Atomic increment-and-window-reset, same statement shape as throttle.ts's
// bump but RETURNING the post-bump state: within the window the count rises;
// once the window has elapsed it resets to 1 with a fresh start. One
// round-trip, correct under concurrent requests on the same key.
async function bumpWindow(
  key: string,
): Promise<{ count: number; windowStart: Date }> {
  const { rows } = await pool.query<{ count: number; window_start: Date }>(
    `INSERT INTO login_attempts (key, count, window_start)
     VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE SET
       count = CASE
         WHEN login_attempts.window_start < now() - make_interval(secs => $2)
         THEN 1 ELSE login_attempts.count + 1 END,
       window_start = CASE
         WHEN login_attempts.window_start < now() - make_interval(secs => $2)
         THEN now() ELSE login_attempts.window_start END
     RETURNING count, window_start`,
    [key, WINDOW_MS / 1000],
  );
  return {
    count: Number(rows[0].count),
    windowStart: new Date(rows[0].window_start),
  };
}

export function rateLimit(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  (async (): Promise<Date | null> => {
    if (PUBLIC_PATHS.has(req.path)) return null;
    // resolvePrincipal runs first, so non-public requests always carry a
    // principal; the ip fallback is defense in depth for any future
    // principal-less path. req.ip is trusted-proxy derived (app.ts), not
    // client-spoofable.
    const principal = (req as Request & { principal?: Principal }).principal;
    const subject =
      principal?.userId ?? req.ip ?? req.socket.remoteAddress ?? "unknown";
    const general = limitFor(
      "RATE_LIMIT_GENERAL_PER_MIN",
      GENERAL_DEFAULT_PER_MIN,
    );
    if (general > 0) {
      const { count, windowStart } = await bumpWindow(`rl:g:${subject}`);
      if (count > general) return windowStart;
    }
    if (isModelRoute(req)) {
      const model = limitFor("RATE_LIMIT_MODEL_PER_MIN", MODEL_DEFAULT_PER_MIN);
      if (model > 0) {
        const { count, windowStart } = await bumpWindow(`rl:m:${subject}`);
        if (count > model) return windowStart;
      }
    }
    return null;
  })()
    .then((limitedWindowStart) => {
      if (limitedWindowStart === null) {
        next();
        return;
      }
      const retryAfterSec = Math.max(
        1,
        Math.ceil(
          (limitedWindowStart.getTime() + WINDOW_MS - Date.now()) / 1000,
        ),
      );
      res.setHeader("Retry-After", String(retryAfterSec));
      res.status(429).json({
        error: `Too many requests. Try again in ${retryAfterSec} second(s).`,
      });
    })
    .catch(next);
}
