// Postgres error-shape knowledge, one home (round 54). Drizzle wraps driver
// errors, so the SQLSTATE lives somewhere down the `cause` chain; five
// modules had grown private copies of this walk and two had drifted to a
// cycle-unsafe variant. The cycle-safe walk is the strict superset — on real
// drizzle/pg errors the variants agree, and only this one survives a
// pathological cyclic or non-object cause chain — so it is the one that
// lives on.

/**
 * True when a unique-constraint violation (SQLSTATE 23505) sits anywhere in
 * the error's cause chain — the concurrency-409 primitive behind
 * POLICY_EXISTS / ALREADY_RUNNING / CASE_DECIDED_CONFLICT and the payment
 * reference race.
 */
export function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<object>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: string; cause?: unknown };
    if (e.code === "23505") return true;
    cur = e.cause;
  }
  return false;
}
