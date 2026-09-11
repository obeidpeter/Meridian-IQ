/**
 * PostgreSQL failures that mean a transaction/session can no longer be used.
 *
 * These are intentionally narrower than "retryable database errors". A
 * serialization failure or a deadlock may be retried by a caller that owns the
 * whole transaction, but a background handler must never blindly replay a
 * transaction after it may already have performed an external side effect.
 */
const CONNECTION_SQLSTATE = /^(08|57P01|57P02|57P03)/;
const CONNECTION_CODES = new Set([
  "DATABASE_CONNECTION_LOST",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
]);
const CONNECTION_MESSAGES = [
  /connection terminated/i,
  /connection ended/i,
  /server closed .*connection/i,
  /connection refused/i,
  /connection reset/i,
  /connection timed out/i,
  /client has encountered a connection error/i,
  /terminating connection due to administrator command/i,
  /the database system is starting up/i,
  /the database system is shutting down/i,
  /timeout exceeded when trying to connect/i,
];

type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  errors?: unknown;
};

function errorParts(error: unknown): ErrorLike[] {
  const parts: ErrorLike[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && parts.length < 8) {
    const current = pending.shift();
    if (
      !current ||
      (typeof current !== "object" && typeof current !== "function")
    )
      continue;
    if (seen.has(current)) continue;
    seen.add(current);
    const value = current as ErrorLike;
    parts.push(value);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors);
  }
  return parts;
}

/**
 * Return true only for a failure that invalidates the current PostgreSQL
 * session or says that a new connection could not be established.
 */
export function isDatabaseConnectionError(error: unknown): boolean {
  return errorParts(error).some((part) => {
    const code = typeof part.code === "string" ? part.code : "";
    const message = typeof part.message === "string" ? part.message : "";
    return (
      CONNECTION_SQLSTATE.test(code) ||
      CONNECTION_CODES.has(code) ||
      CONNECTION_MESSAGES.some((pattern) => pattern.test(message))
    );
  });
}

/**
 * Preserve the original error while making a connection loss explicit to
 * callers that need to choose a safe recovery policy. The cause remains
 * available for diagnostics, but callers should avoid logging it verbatim
 * where it could contain provider or connection details.
 */
export class DatabaseConnectionError extends Error {
  readonly code = "DATABASE_CONNECTION_LOST";

  constructor(cause: unknown) {
    super("Database connection lost", { cause });
    this.name = "DatabaseConnectionError";
  }
}

export function asDatabaseConnectionError(
  error: unknown,
): DatabaseConnectionError {
  return error instanceof DatabaseConnectionError
    ? error
    : new DatabaseConnectionError(error);
}
