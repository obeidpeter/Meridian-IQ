import { pool } from "@workspace/db";

// The one home for the fixed-window counter bump shared by the login/action
// throttle (modules/auth/throttle.ts) and the per-principal rate limiter
// (middleware/rate-limit.ts) — previously two byte-identical statements held
// in lockstep by prose. Both count in the login_attempts table under their
// own namespaced keys.
//
// Atomic increment-and-window-reset: within the window the count rises; once
// the window has elapsed it resets to 1 with a fresh start. RETURNING keeps it
// a single round-trip and correct under concurrent bumps on the same key —
// every concurrent bump on one key observes a distinct post-increment count.
//
// MUST stay on the RAW pool, never getDb(): callers run under the 4xx
// rollback rule (app.ts tenantContext rolls the request transaction back on
// any 4xx), and a count written inside the request transaction would be
// erased by the very 401/429 it produced.
export async function bumpFixedWindow(
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
