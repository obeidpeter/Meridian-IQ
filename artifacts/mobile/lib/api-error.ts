/**
 * Duck-typed helpers for errors thrown by the generated API client. The
 * generated ApiError class isn't re-exported from the package index, so
 * screens read its `status`/`data` shape structurally instead.
 */

/** The HTTP status carried by a thrown API error, if it has a numeric one. */
export function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

/** Whether a thrown error carries the given HTTP status code. */
export function hasStatus(error: unknown, code: number): boolean {
  return errorStatus(error) === code;
}

/** A dark feature flag surfaces as a 404 from the API. */
export function isFeatureUnavailable(error: unknown): boolean {
  return hasStatus(error, 404);
}

/**
 * The server-provided `message` string from a thrown API error's payload, or
 * null when the payload carries none.
 */
export function serverMessage(error: unknown): string | null {
  const data =
    error && typeof error === "object"
      ? (error as { data?: unknown }).data
      : null;
  if (data && typeof data === "object" && "message" in data) {
    const message = (data as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return null;
}

/**
 * Pull the server's message out of a thrown API error, if present. The 403
 * consent refusal from bulk submit arrives as `{ error }`; validation-style
 * failures use `{ message }`. When the payload carries neither, a thrown
 * Error's own message (e.g. a transport failure) is used before the fallback.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const fromServer = serverMessage(error);
  if (fromServer) return fromServer;
  const data =
    error && typeof error === "object"
      ? (error as { data?: unknown }).data
      : null;
  if (data && typeof data === "object" && "error" in data) {
    const message = (data as { error?: unknown }).error;
    if (typeof message === "string" && message) return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
