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
 * Clerk endpoints answer 503 while the clerk_ai kill switch is off.
 */
export function killSwitchTripped(err: unknown): boolean {
  return errorStatus(err) === 503;
}

// The generated client's ApiError carries the parsed JSON error body on
// `data`; server errors are `{ error: string }`. Used to relay the server's
// own words (409 CASE_CLAIMED / CASE_CLAIM_CONFLICT, 422 VOICE_*).
export function serverErrorMessage(err: unknown): string | undefined {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  return typeof data?.error === "string" ? data.error : undefined;
}
