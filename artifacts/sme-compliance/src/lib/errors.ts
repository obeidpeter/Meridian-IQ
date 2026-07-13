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
 * The generated client throws an ApiError whose `data` carries the server's
 * `{ error }` body (e.g. the 403 "consent required" refusal or the
 * invalid-TIN 400). The package does not export the class itself, so
 * duck-type the field.
 */
export function serverErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error: unknown }).error === "string"
    ) {
      return (data as { error: string }).error;
    }
  }
  return error instanceof Error ? error.message : "Please try again.";
}
