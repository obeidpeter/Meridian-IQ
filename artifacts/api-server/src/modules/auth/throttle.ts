import type { Request } from "express";
import { pool } from "@workspace/db";
import { bumpFixedWindow } from "../../lib/fixed-window";
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
const IP_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_IP_ATTEMPT_MAX = 30;
const configuredIpAttemptMax = Number(process.env.LOGIN_IP_ATTEMPT_MAX);
// The override exists for trusted synthetic runners that exercise many users
// from one loopback address. Production keeps the conservative default unless
// an operator deliberately supplies a bounded positive override.
const IP_ATTEMPT_MAX =
  Number.isSafeInteger(configuredIpAttemptMax) &&
  configuredIpAttemptMax >= DEFAULT_IP_ATTEMPT_MAX &&
  configuredIpAttemptMax <= 1_000
    ? configuredIpAttemptMax
    : DEFAULT_IP_ATTEMPT_MAX;

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function ipKey(req: Request, email: string): string {
  // req.ip is derived from the trusted-proxy hop count (app.set("trust proxy")),
  // so it reflects the real client and cannot be spoofed via X-Forwarded-For.
  return `${normalizeEmail(email)}|${requestIp(req)}`;
}

// Count every login attempt before account lookup or scrypt. This aggregate IP
// gate cannot be evaded by rotating fabricated email addresses and therefore
// bounds unauthenticated KDF work independently of the account protections.
export async function throttleLoginAttempt(
  req: Request,
): Promise<number | null> {
  const row = await bumpFixedWindow(
    `login-ip:${requestIp(req)}`,
    IP_ATTEMPT_WINDOW_MS,
  );
  if (row.count <= IP_ATTEMPT_MAX) return null;
  const elapsed = Date.now() - new Date(row.window_start).getTime();
  return Math.max(1, Math.ceil((IP_ATTEMPT_WINDOW_MS - elapsed) / 1000));
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

// Reserve against both credential caps before the password KDF runs. Each
// increment is atomic, so concurrent requests observe distinct counts instead
// of all passing a stale check. A successful login clears both reservations;
// failed attempts remain in the fixed window.
function retryAfterReservedAttempt(
  row: { count: number; window_start: Date },
  windowMs: number,
  max: number,
): number | null {
  if (row.count <= max) return null;
  const elapsed = Date.now() - new Date(row.window_start).getTime();
  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
}

export async function throttleLoginCredentials(
  req: Request,
  email: string,
): Promise<number | null> {
  const ipK = ipKey(req, email);
  const acctK = accountKey(email);
  const [ipRow, accountRow] = await Promise.all([
    bumpFixedWindow(ipK, LOGIN_WINDOW_MS),
    bumpFixedWindow(acctK, ACCOUNT_WINDOW_MS),
  ]);
  const waits = [
    retryAfterReservedAttempt(ipRow, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES),
    retryAfterReservedAttempt(
      accountRow,
      ACCOUNT_WINDOW_MS,
      ACCOUNT_MAX_FAILURES,
    ),
  ].filter((w): w is number => w !== null);
  return waits.length ? Math.max(...waits) : null;
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
  await bumpFixedWindow(key, ACTION_WINDOW_MS);
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
  const row = await bumpFixedWindow(key, ACTION_WINDOW_MS);
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
