// The ApiError duck-typing and the Clerk gateway status policy live in the
// workspace package so the apps classify rejections identically; the console
// keeps raw errors available for classification and translates display errors.
export {
  errorStatus,
  isFeatureDisabled,
  isForbidden,
  killSwitchTripped,
  serverError as serverErrorMessage,
  userErrorMessage,
} from "@workspace/api-errors";

import { userErrorMessage } from "@workspace/api-errors";

// Structural toast type so this module stays hook-free (its unit test never
// mounts React): any toast function that accepts a destructive payload fits,
// including the real useToast()'s.
type DestructiveToast = (input: {
  title: string;
  description: string;
  variant: "destructive";
}) => unknown;

/**
 * The generic server-error toast: translate generic failures for display,
 * otherwise use the caller's fallback. The third argument is either the
 * fallback string alone (title stays "Something went wrong") or
 * `{ title, fallback }` for callers that name the failed action — the one
 * pattern behind every "destructive toast with Try again" in the console.
 */
export function serverErrorToast(
  toast: DestructiveToast,
  err: unknown,
  fallback: string | { title?: string; fallback: string },
): void {
  const opts = typeof fallback === "string" ? { fallback } : fallback;
  toast({
    title: opts.title ?? "Something went wrong",
    description: userErrorMessage(err) ?? opts.fallback,
    variant: "destructive",
  });
}
