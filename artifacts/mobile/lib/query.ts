import {
  MutationCache,
  onlineManager,
  QueryCache,
  QueryClient,
} from "@tanstack/react-query";
import * as Network from "expo-network";
import { Platform } from "react-native";

import { hasStatus } from "./api-error";

// Wire React Query's connectivity to the real device network state (SEC/reliability).
// Without this, React Query in React Native never observes connectivity: queries
// aren't paused offline and `refetchOnReconnect` never fires. On web the default
// (browser online/offline events) is already correct, so only override on native.
if (Platform.OS !== "web") {
  onlineManager.setEventListener((setOnline) => {
    let changed = false;
    let active = true;
    // Seed with the current state, then subscribe to changes.
    Network.getNetworkStateAsync()
      .then((state) => {
        if (active && !changed)
          setOnline(
            state.isConnected !== false && state.isInternetReachable !== false,
          );
      })
      .catch(() => {});
    const subscription = Network.addNetworkStateListener((state) => {
      changed = true;
      setOnline(
        state.isConnected !== false && state.isInternetReachable !== false,
      );
    });
    return () => {
      active = false;
      subscription.remove();
    };
  });
}

/**
 * A single shared QueryClient for the whole app, wired with global error
 * handling so that any 401 from the API server clears the local session.
 *
 * The unauthorized handler is registered by the SessionProvider at runtime —
 * this keeps the module free of React dependencies while still letting the
 * provider react to expired/invalid tokens.
 */

let onUnauthorized: (() => void) | null = null;
let authGeneration = 0;
let sessionVerified = false;
const requestGenerations = new WeakMap<object, number>();

export function getAuthGeneration(): number {
  return authGeneration;
}
export function setSessionVerified(verified: boolean): void {
  sessionVerified = verified;
}

// Some mobile workflows call the generated functions directly, outside React
// Query. Fence their writes and response bodies at the network boundary too.
export function guardSessionFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request =
      typeof Request !== "undefined" && input instanceof Request ? input : null;
    const raw = request?.url ?? String(input);
    const path = new URL(raw, "https://mobile.invalid").pathname;
    if (!path.startsWith("/api/")) return fetcher(input, init);
    const epoch = authGeneration;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const sessionAction = [
      "/api/auth/login",
      "/api/auth/totp/challenge",
      "/api/auth/logout",
      "/api/sme/push/devices/unregister",
    ].includes(path);
    if (
      !sessionVerified &&
      !["GET", "HEAD", "OPTIONS"].includes(method) &&
      !sessionAction
    ) {
      throw new Error("Verify your session online before making changes.");
    }
    const assertCurrent = () => {
      if (epoch !== authGeneration)
        throw new Error("This request belongs to a previous session.");
    };
    const response = await fetcher(input, init);
    assertCurrent();
    for (const method of ["text", "json", "blob", "arrayBuffer"] as const) {
      if (typeof response[method] !== "function") continue;
      const read = response[method].bind(response);
      Object.defineProperty(response, method, {
        configurable: true,
        value: async () => {
          const body = await read();
          assertCurrent();
          return body;
        },
      });
    }
    return response;
  };
}
if (typeof globalThis.fetch === "function") {
  globalThis.fetch = guardSessionFetch(globalThis.fetch.bind(globalThis));
}
export function advanceAuthGeneration(): number {
  authGeneration++;
  sessionVerified = false;
  void queryClient.cancelQueries();
  queryClient.clear();
  return authGeneration;
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * The generated ApiError class isn't re-exported from the package index, so we
 * duck-type it here: any thrown error carrying a numeric `status` of 401.
 */
function isUnauthorized(error: unknown): boolean {
  return hasStatus(error, 401);
}

function handleError(error: unknown, request: object): void {
  if (
    requestGenerations.get(request) === authGeneration &&
    isUnauthorized(error)
  ) {
    onUnauthorized?.();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleError }),
  mutationCache: new MutationCache({
    onMutate: (_variables, mutation) => {
      requestGenerations.set(mutation, authGeneration);
      const key = mutation.options.mutationKey?.[0];
      if (!sessionVerified && key !== "login" && key !== "totpChallenge") {
        throw new Error("Verify your session online before making changes.");
      }
    },
    onSuccess: (_data, _variables, _context, mutation) => {
      if (requestGenerations.get(mutation) !== authGeneration) {
        throw new Error("This request belongs to a previous session.");
      }
    },
    onError: (error, _variables, _context, mutation) =>
      handleError(error, mutation),
  }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !isUnauthorized(error) && count < 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Now that onlineManager tracks real connectivity, refetch stale data when
      // the device comes back online.
      refetchOnReconnect: true,
    },
  },
});

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "fetch") {
    requestGenerations.set(event.query, authGeneration);
  }
});
