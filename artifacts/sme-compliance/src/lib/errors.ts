// The ApiError duck-typing and the Clerk gateway status policy live in the
// workspace package so the apps classify rejections identically; this facade
// keeps the SME app's client-friendly fallback wording.
export { errorStatus, isFeatureDisabled } from "@workspace/api-errors";

import { serverError } from "@workspace/api-errors";

/**
 * The server's own `{ error }` body message when it sent one, otherwise the
 * thrown error's message, otherwise a client-friendly nudge.
 */
export function serverErrorMessage(error: unknown): string {
  return (
    serverError(error) ??
    (error instanceof Error ? error.message : "Please try again.")
  );
}
