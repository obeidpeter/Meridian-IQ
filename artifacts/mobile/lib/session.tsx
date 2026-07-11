import AsyncStorage from "@react-native-async-storage/async-storage";
import { setAuthTokenGetter, unregisterPushDevice } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { queryClient, setUnauthorizedHandler } from "@/lib/query";

const TOKEN_KEY = "miq_token";
const ME_KEY = "miq_me";
const PUSH_TOKEN_KEY = "miq_push_token";
const CLIENT_PARTY_KEY = "miq_client_party";

// Module-level token cache read by the API client before every request.
// Kept outside React so the bearer getter never depends on render timing.
let currentToken: string | null = null;
setAuthTokenGetter(() => currentToken);

async function secureGet(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function secureSet(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    // Non-fatal: secure storage may be unavailable in some sandboxes.
  }
}

async function secureDelete(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}

export type SessionStatus = "loading" | "authenticated" | "anonymous";

interface SessionContextValue {
  status: SessionStatus;
  me: Me | null;
  /** The effective client party the app operates on (may need selection). */
  clientPartyId: string | null;
  /** True when the principal has no client scope and must pick one. */
  needsClientSelection: boolean;
  signIn: (me: Me) => Promise<void>;
  signOut: () => Promise<void>;
  selectClient: (partyId: string) => Promise<void>;
  /** Persist the Expo push token so sign-out can unregister it. */
  setPushToken: (token: string | null) => Promise<void>;
  getPushToken: () => Promise<string | null>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const signOut = useCallback(async () => {
    const pushToken = await secureGet(PUSH_TOKEN_KEY);
    if (pushToken && currentToken) {
      try {
        await unregisterPushDevice({ expoPushToken: pushToken });
      } catch {
        // Best effort — proceed with local sign-out regardless.
      }
    }
    currentToken = null;
    await Promise.all([
      secureDelete(TOKEN_KEY),
      secureDelete(ME_KEY),
      secureDelete(PUSH_TOKEN_KEY),
    ]);
    try {
      await AsyncStorage.removeItem(CLIENT_PARTY_KEY);
    } catch {
      // ignore
    }
    queryClient.clear();
    setMe(null);
    setSelectedClientId(null);
    setStatus("anonymous");
  }, []);

  // Register the global 401 handler once.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (currentToken) {
        void signOut();
      }
    });
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  // Hydrate persisted session on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      const [token, meRaw, storedClient] = await Promise.all([
        secureGet(TOKEN_KEY),
        secureGet(ME_KEY),
        AsyncStorage.getItem(CLIENT_PARTY_KEY).catch(() => null),
      ]);
      if (!active) return;
      if (token && meRaw) {
        try {
          const parsed = JSON.parse(meRaw) as Me;
          currentToken = token;
          setMe(parsed);
          setSelectedClientId(storedClient ?? null);
          setStatus("authenticated");
          return;
        } catch {
          // Corrupt payload — fall through to anonymous.
        }
      }
      setStatus("anonymous");
    })();
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(async (nextMe: Me) => {
    const token = nextMe.token ?? null;
    if (!token) {
      throw new Error("Sign-in response did not include an auth token.");
    }
    currentToken = token;
    await Promise.all([
      secureSet(TOKEN_KEY, token),
      secureSet(ME_KEY, JSON.stringify(nextMe)),
    ]);
    setMe(nextMe);
    setStatus("authenticated");
  }, []);

  const selectClient = useCallback(async (partyId: string) => {
    setSelectedClientId(partyId);
    try {
      await AsyncStorage.setItem(CLIENT_PARTY_KEY, partyId);
    } catch {
      // ignore persistence failure
    }
  }, []);

  const setPushToken = useCallback(async (token: string | null) => {
    if (token) {
      await secureSet(PUSH_TOKEN_KEY, token);
    } else {
      await secureDelete(PUSH_TOKEN_KEY);
    }
  }, []);

  const getPushToken = useCallback(() => secureGet(PUSH_TOKEN_KEY), []);

  const clientPartyId = me?.clientPartyId ?? selectedClientId;
  const needsClientSelection =
    status === "authenticated" && !me?.clientPartyId && !selectedClientId;

  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      me,
      clientPartyId,
      needsClientSelection,
      signIn,
      signOut,
      selectClient,
      setPushToken,
      getPushToken,
    }),
    [
      status,
      me,
      clientPartyId,
      needsClientSelection,
      signIn,
      signOut,
      selectClient,
      setPushToken,
      getPushToken,
    ],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within a SessionProvider");
  }
  return ctx;
}
