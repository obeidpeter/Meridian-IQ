import type { PoolConfig } from "pg";

type Environment = Record<string, string | undefined>;

function integer(
  env: Environment,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(Number(raw)) ||
    Number(raw) < min ||
    Number(raw) > max
  ) {
    throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  return Number(raw);
}

export function connectionConfig(env: Environment = process.env): PoolConfig {
  if (env.DATABASE_URL) {
    let url: URL;
    try {
      url = new URL(env.DATABASE_URL);
    } catch {
      throw new Error("DATABASE_URL must be a valid PostgreSQL URL");
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol))
      throw new Error("DATABASE_URL must use PostgreSQL");
    // node-postgres lets URL query parameters override PoolConfig. Refuse
    // alternate deadline knobs rather than silently losing server deadlines.
    for (const key of [
      "statement_timeout",
      "lock_timeout",
      "idle_in_transaction_session_timeout",
      "query_timeout",
      "connectionTimeoutMillis",
      "options",
    ]) {
      if (url.searchParams.has(key))
        throw new Error(
          `DATABASE_URL cannot override ${key}; use the validated PG_* settings`,
        );
    }
  }
  if (
    /statement_timeout|lock_timeout|idle_in_transaction_session_timeout/i.test(
      env.PGOPTIONS ?? "",
    )
  ) {
    throw new Error(
      "PGOPTIONS cannot override database deadlines; use the validated PG_* settings",
    );
  }
  const statement = integer(
    env,
    "PG_STATEMENT_TIMEOUT_MS",
    15_000,
    100,
    120_000,
  );
  const lock = integer(env, "PG_LOCK_TIMEOUT_MS", 2_000, 50, 30_000);
  if (lock >= statement)
    throw new Error(
      "PG_LOCK_TIMEOUT_MS must be less than PG_STATEMENT_TIMEOUT_MS",
    );
  // These are server deadlines, not a JS race that leaves a query running.
  // Do not set query_timeout: a client-only timeout cannot safely reuse a session.
  return {
    connectionString: env.DATABASE_URL,
    max: integer(env, "PGPOOL_MAX", 20, 4, 100),
    connectionTimeoutMillis: integer(
      env,
      "PG_CONNECT_TIMEOUT_MS",
      5_000,
      100,
      10_000,
    ),
    idleTimeoutMillis: 30_000,
    statement_timeout: statement,
    lock_timeout: lock,
    idle_in_transaction_session_timeout: integer(
      env,
      "PG_IDLE_TRANSACTION_TIMEOUT_MS",
      30_000,
      1_000,
      120_000,
    ),
    keepAlive: true,
    application_name: "meridian-api",
  };
}

export function workerConnectionConfig(
  env: Environment = process.env,
): PoolConfig {
  return {
    ...connectionConfig(env),
    // Only sweep/reconcile orchestration locks live here. Domain queries use
    // the ordinary pool, so lock ownership cannot consume HTTP headroom.
    max: integer(env, "PG_WORKER_LOCK_POOL_MAX", 2, 2, 4),
    application_name: "meridian-worker-locks",
  };
}
