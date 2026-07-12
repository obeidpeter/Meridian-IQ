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

/**
 * Domain routes answer 4xx with a JSON body of { error } (the error boundary
 * in middleware/error.ts) or occasionally { message }. Prefer that text for
 * toasts — it names the exact problem (e.g. which critical fields are still
 * unconfirmed, or the maker-checker refusal) — falling back to the ApiError's
 * own message and then to a generic prompt.
 */
export function serverErrorMessage(
  error: unknown,
  fallback = "Please try again.",
): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object") {
      const { error: err, message } = data as {
        error?: unknown;
        message?: unknown;
      };
      if (typeof err === "string" && err) return err;
      if (typeof message === "string" && message) return message;
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
