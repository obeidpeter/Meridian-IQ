import type { Request } from "express";
import { pool } from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { normalizeEmail } from "./session";

// Persistent login throttle (SEC-02, SEC-M4). Two independent fixed-window
// counters, both of which must pass:
//   1. per email+IP — a tight cap that stops probing from one source.
//   2. per email — a looser account-scoped cap that a distributed
//      credential-stuffing run (many source IPs) cannot evade, since the key
//      omits the IP. Deliberately looser so a bystander cannot cheaply lock a
//      victim out (availability) while still bounding aggregate online guesses.
//
// Counts live in the login_attempts table rather than process memory so the
// cap holds across a multi-instance deployment. All reads and writes use the
// RAW pool connection — NOT getDb()'s request transaction — because a failed
// login returns 401 and the per-request transaction rolls back on any 4xx
// (app.ts tenantContext), which would silently discard the recorded attempt.
// The pool's login role bypasses RLS, so the counters are reachable pre-auth.

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ACCOUNT_WINDOW_MS = 60 * 60 * 1000;
const ACCOUNT_MAX_FAILURES = 50;

function ipKey(req: Request, email: string): string {
  // req.ip is derived from the trusted-proxy hop count (app.set("trust proxy")),
  // so it reflects the real client and cannot be spoofed via X-Forwarded-For.
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return `${normalizeEmail(email)}|${ip}`;
}

function accountKey(email: string): string {
  return `acct:${normalizeEmail(email)}`;
}

function retryAfter(
  row: { count: number; window_start: Date } | undefined,
  windowMs: number,
  max: number,
): number | null {
  if (!row) return null;
  const elapsed = Date.now() - new Date(row.window_start).getTime();
  if (elapsed > windowMs) return null; // window expired; next failure resets it
  if (row.count >= max) return Math.ceil((windowMs - elapsed) / 1000);
  return null;
}

// The wait, in seconds, before this attempt is allowed — or null if not
// throttled. Both counters are read in ONE query (a single pooled connection,
// so the login — which already holds its own request-transaction connection —
// borrows at most one more), then the longer wait wins.
export async function isLoginThrottled(
  req: Request,
  email: string,
): Promise<number | null> {
  const ipK = ipKey(req, email);
  const acctK = accountKey(email);
  const { rows } = await pool.query<{
    key: string;
    count: number;
    window_start: Date;
  }>("SELECT key, count, window_start FROM login_attempts WHERE key = ANY($1)", [
    [ipK, acctK],
  ]);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const waits = [
    retryAfter(byKey.get(ipK), LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES),
    retryAfter(byKey.get(acctK), ACCOUNT_WINDOW_MS, ACCOUNT_MAX_FAILURES),
  ].filter((w): w is number => w !== null);
  return waits.length ? Math.max(...waits) : null;
}

// Atomic increment-and-window-reset: within the window the count rises; once
// the window has elapsed it resets to 1 with a fresh start. RETURNING keeps it
// a single round-trip and correct under concurrent failures on the same key —
// every concurrent bump on one key observes a distinct post-increment count.
async function bump(
  key: string,
  windowMs: number,
): Promise<{ count: number; window_start: Date }> {
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
    [key, windowMs / 1000],
  );
  return rows[0];
}

export async function recordLoginFailure(
  req: Request,
  email: string,
): Promise<void> {
  await Promise.all([
    bump(ipKey(req, email), LOGIN_WINDOW_MS),
    bump(accountKey(email), ACCOUNT_WINDOW_MS),
  ]);
}

export async function clearLoginFailures(
  req: Request,
  email: string,
): Promise<void> {
  await pool.query("DELETE FROM login_attempts WHERE key = ANY($1)", [
    [ipKey(req, email), accountKey(email)],
  ]);
}

// Generic single-key action throttle on the same login_attempts table and the
// same raw-pool posture (counters must survive the 4xx rollback). Used for
// authenticated credential checks that would otherwise allow unlimited online
// guessing — today the change-password current-password check, where a stolen
// session cookie must not be brute-forceable into a full account takeover.
// Callers namespace their keys (e.g. "chpw:<userId>").
const ACTION_WINDOW_MS = 15 * 60 * 1000;
const ACTION_MAX_FAILURES = 5;

// The wait, in seconds, before this action is allowed — or null if not
// throttled.
export async function isActionThrottled(key: string): Promise<number | null> {
  const { rows } = await pool.query<{ count: number; window_start: Date }>(
    "SELECT count, window_start FROM login_attempts WHERE key = $1",
    [key],
  );
  return retryAfter(rows[0], ACTION_WINDOW_MS, ACTION_MAX_FAILURES);
}

export async function recordActionFailure(key: string): Promise<void> {
  await bump(key, ACTION_WINDOW_MS);
}

// Atomic bump-FIRST gate for burst-exposed credential checks (e.g. the public,
// limiter-exempt /auth/totp/challenge): the attempt is counted and the
// post-increment count read in ONE statement, so N concurrent attempts see N
// distinct counts and every one past the cap is refused — unlike the
// isActionThrottled → recordActionFailure pair, where a concurrent burst can
// pass the SELECT gate before any failure lands (TOCTOU). Returns null when
// this attempt is allowed, else the wait in seconds. Callers gating with this
// must NOT also call recordActionFailure (the attempt is already counted);
// clearActionFailures on success keeps legitimate users from accumulating
// attempts toward the cap.
export async function throttleActionAttempt(
  key: string,
): Promise<number | null> {
  const row = await bump(key, ACTION_WINDOW_MS);
  if (row.count <= ACTION_MAX_FAILURES) return null;
  const elapsed = Date.now() - new Date(row.window_start).getTime();
  return Math.max(1, Math.ceil((ACTION_WINDOW_MS - elapsed) / 1000));
}

export async function clearActionFailures(key: string): Promise<void> {
  await pool.query("DELETE FROM login_attempts WHERE key = $1", [key]);
}

// Prune rows whose window has fully elapsed (past the longer account window),
// so the table cannot grow unboundedly with one row per distinct email+IP that
// ever failed. Registered on the shared minute sweep loop; a small indexed
// delete is a cheap no-op when nothing is stale. Errors deliberately propagate
// to the sweep runner, which logs them and increments the OBS-01 error metric —
// an inner catch here would hide failures from monitoring.
async function sweepExpiredLoginAttempts(): Promise<void> {
  await pool.query(
    "DELETE FROM login_attempts WHERE window_start < now() - make_interval(secs => $1)",
    [ACCOUNT_WINDOW_MS / 1000],
  );
}

registerSweep(sweepExpiredLoginAttempts);
