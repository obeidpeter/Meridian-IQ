import {
  MutationCache,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";

/**
 * A single shared QueryClient for the whole app, wired with global error
 * handling so that any 401 from the API server clears the local session.
 *
 * The unauthorized handler is registered by the SessionProvider at runtime —
 * this keeps the module free of React dependencies while still letting the
 * provider react to expired/invalid tokens.
 */

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * The generated ApiError class isn't re-exported from the package index, so we
 * duck-type it here: any thrown error carrying a numeric `status` of 401.
 */
function isUnauthorized(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status?: unknown }).status === 401
  );
}

function handleError(error: unknown): void {
  if (isUnauthorized(error)) {
    onUnauthorized?.();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleError }),
  mutationCache: new MutationCache({ onError: handleError }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
});
