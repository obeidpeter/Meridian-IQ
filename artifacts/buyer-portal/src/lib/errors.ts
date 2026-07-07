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
