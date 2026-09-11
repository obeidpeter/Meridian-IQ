// Shared duck-typing over the generated client's ApiError (the package does
// not export the class itself) plus the Clerk gateway's status policy, so the
// three web apps classify the same rejection the same way. App-specific
// fallback wording stays in each app's src/lib/errors.ts facade.

/**
 * R2 backend routes return HTTP 404 while their feature flag is dark. The
 * generated client throws an ApiError carrying the response status; the
 * package does not export the class itself, so duck-type the status field.
 */
export function errorStatus(error: unknown): number | undefined {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    typeof (error as { status: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return undefined;
}

export function isFeatureDisabled(error: unknown): boolean {
  return errorStatus(error) === 404;
}

/**
 * Operator endpoints answer 403 when the signed-in principal is not an
 * operator. Duck-type the status the same way as isFeatureDisabled.
 */
export function isForbidden(error: unknown): boolean {
  return errorStatus(error) === 403;
}

// ---- Clerk gateway status policy -------------------------------------------
// The one home for what the gateway's rejection statuses MEAN, so console and
// SME cannot silently diverge when a new code is added. How each app renders
// them (banner copy, toast titles) stays per-app by design.

/** Clerk endpoints answer 503 while the clerk_ai kill switch is off. */
export function killSwitchTripped(err: unknown): boolean {
  return errorStatus(err) === 503;
}

/** 429 CLERK_BUDGET_EXHAUSTED: the firm's monthly token allowance is spent. */
export function clerkBudgetExhausted(err: unknown): boolean {
  return errorStatus(err) === 429;
}

/**
 * The generated client's ApiError carries the parsed JSON error body on
 * `data`; server errors are `{ error: string }`. Returns the server's own
 * words when it sent any — fallbacks are the caller's business.
 */
export function serverError(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}

// Presentation only: keep serverError unchanged for callers that classify
// exact server messages. Never imply that a failed response means no write.
const FRIENDLY_ERRORS: Readonly<Record<string, string>> = {
  "Internal server error":
    "Valo could not finish this request. Check the latest status before trying again.",
  Unauthorized: "Please sign in again to continue.",
  Forbidden: "Your account does not have permission to do this.",
  "Failed to fetch":
    "The connection was lost before Valo could confirm the result. Check your connection and the latest status before trying again.",
  "Network Error":
    "The connection was lost before Valo could confirm the result. Check your connection and the latest status before trying again.",
  "Network request failed":
    "The connection was lost before Valo could confirm the result. Check your connection and the latest status before trying again.",
  "Request timed out":
    "This request took too long. Its result is not confirmed. Check the latest status before trying again.",
};

/** Plain-language display text without changing error codes or classification. */
export function userErrorMessage(err: unknown): string | undefined {
  const message =
    serverError(err) ?? (err instanceof Error ? err.message : undefined);
  if (!message) return undefined;
  return Object.hasOwn(FRIENDLY_ERRORS, message)
    ? FRIENDLY_ERRORS[message]
    : message;
}

/** Opaque support reference returned in the API response header. */
export function requestReference(err: unknown): string | undefined {
  const value = (err as { requestId?: unknown } | null)?.requestId;
  return typeof value === "string" && value.trim() ? value : undefined;
}
