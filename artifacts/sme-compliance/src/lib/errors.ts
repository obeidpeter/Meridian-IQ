// The ApiError duck-typing and the Clerk gateway status policy live in the
// workspace package so the apps classify rejections identically; this facade
// keeps the SME app's client-friendly fallback wording.
export { errorStatus, isFeatureDisabled } from "@workspace/api-errors";

import { userErrorMessage } from "@workspace/api-errors";

/**
 * Keep specific server instructions, with plain-language text for generic
 * failures and a fallback when no message was provided.
 */
export function serverErrorMessage(error: unknown): string {
  return userErrorMessage(error) ?? "Something went wrong. Please try again.";
}
