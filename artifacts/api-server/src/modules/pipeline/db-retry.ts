export type WorkerName = "drain" | "reconcile" | "compliance";

export interface PostgresFailure {
  transient: boolean;
  code: string;
}

const TRANSIENT_CODES = new Set([
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);
const TRANSIENT_SYSTEM_CODES = new Set([
  "DATABASE_CONNECTION_LOST",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);
const PG_CONNECTION_MESSAGES =
  /^(Connection terminated(?: unexpectedly)?|Connection terminated due to connection timeout|Client has encountered a connection error and is not queryable|timeout exceeded when trying to connect)$/i;

function postgresCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === "string" &&
      /^[A-Z0-9_]{2,32}$/.test(candidate.code)
    ) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return undefined;
}

/** Retry only PostgreSQL availability failures. Unknown, integrity, query,
 * cancellation, and application errors fail immediately. */
export function classifyPostgresFailure(error: unknown): PostgresFailure {
  const code = postgresCode(error);
  const message = error instanceof Error ? error.message : "";
  return {
    transient:
      (code !== undefined &&
        (code.startsWith("08") ||
          TRANSIENT_CODES.has(code) ||
          TRANSIENT_SYSTEM_CODES.has(code))) ||
      (code === undefined && PG_CONNECTION_MESSAGES.test(message)),
    code: code ?? "unknown",
  };
}

export interface WorkerRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  signal: AbortSignal;
  onRetry?: (details: {
    attempt: number;
    delayMs: number;
    code: string;
  }) => void;
  onExhausted?: (details: { attempts: number; code: string }) => void;
  onRecovered?: (details: { attempts: number }) => void;
}

export class WorkerRetryStoppedError extends Error {
  constructor() {
    super("Worker retry stopped");
    this.name = "WorkerRetryStoppedError";
  }
}

export function retryDelayMs(
  failedAttempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, failedAttempt - 1),
  );
  return Math.floor(ceiling * Math.max(0, Math.min(1, random())));
}

export function abortableSleep(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(new WorkerRetryStoppedError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(new WorkerRetryStoppedError());
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function withTransientDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: WorkerRetryOptions,
): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  let retries = 0;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    if (options.signal.aborted) throw new WorkerRetryStoppedError();
    try {
      const result = await operation();
      if (retries > 0) options.onRecovered?.({ attempts: attempt });
      return result;
    } catch (error) {
      const failure = classifyPostgresFailure(error);
      if (!failure.transient) throw error;
      if (attempt >= options.maxAttempts) {
        options.onExhausted?.({ attempts: attempt, code: failure.code });
        throw error;
      }
      retries += 1;
      const delayMs = retryDelayMs(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
        random,
      );
      options.onRetry?.({ attempt, delayMs, code: failure.code });
      await sleep(delayMs, options.signal);
    }
  }
  throw new Error("Unreachable worker retry state");
}
