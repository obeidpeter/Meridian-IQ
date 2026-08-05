// The ApiError duck-typing and the Clerk gateway status policy live in the
// workspace package so the apps classify rejections identically; the console
// relays the server's words as-is (fallbacks are per-toast).
export {
  errorStatus,
  isFeatureDisabled,
  isForbidden,
  killSwitchTripped,
  serverError as serverErrorMessage,
} from "@workspace/api-errors";

import { serverError } from "@workspace/api-errors";

// Structural toast type so this module stays hook-free (its unit test never
// mounts React): any toast function that accepts a destructive payload fits,
// including the real useToast()'s.
type DestructiveToast = (input: {
  title: string;
  description: string;
  variant: "destructive";
}) => unknown;

/**
 * The generic server-error toast: relay the server's own words when it sent
 * any, otherwise the caller's fallback. The third argument is either the
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
    description: serverError(err) ?? opts.fallback,
    variant: "destructive",
  });
}
