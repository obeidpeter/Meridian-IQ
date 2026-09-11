import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  getMe,
  logout,
  setAuthTokenGetter,
  unregisterPushDevice,
} from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import { onlineManager } from "@tanstack/react-query";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, Button, Text, View, useColorScheme } from "react-native";
import colors from "../constants/colors";
import { hasStatus } from "./api-error";
import { clearInvoiceIntents } from "./invoice-intent";
import {
  advanceAuthGeneration,
  getAuthGeneration,
  queryClient,
  setSessionVerified,
  setUnauthorizedHandler,
} from "./query";

const TOKEN_KEY = "miq_token";
const ME_KEY = "miq_me";
const PUSH_TOKEN_KEY = "miq_push_token";
const CLIENT_PARTY_KEY = "miq_client_party";

let currentToken: string | null = null;
setAuthTokenGetter(() => currentToken);

// Serialize secure writes and deletes. A logout queued after a slow sign-in
// write must erase that write, and must finish before a newer login persists.
let storageQueue: Promise<unknown> = Promise.resolve();
function storeInOrder(work: () => Promise<void>): Promise<void> {
  const result = storageQueue.then(work, work);
  storageQueue = result.catch(() => {});
  return result;
}

export type SessionStatus = "loading" | "authenticated" | "anonymous";
interface SessionContextValue {
  status: SessionStatus;
  me: Me | null;
  clientPartyId: string | null;
  needsClientSelection: boolean;
  verified: boolean;
  persistenceError: string | null;
  revalidate: () => Promise<void>;
  signIn: (me: Me) => Promise<void>;
  signOut: () => Promise<void>;
  selectClient: (partyId: string) => Promise<void>;
  switchClient: () => Promise<void>;
  setPushToken: (token: string | null) => Promise<void>;
  getPushToken: () => Promise<string | null>;
}
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const identity = useRef<Me | null>(null);
  const validatedThisRun = useRef(false);
  const validation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const palette = useColorScheme() === "dark" ? colors.dark : colors.light;

  const reportStorageFailure = useCallback(() => {
    if (mounted.current)
      setPersistenceError(
        "Secure session storage is unavailable. This session may not be remembered; sign out again when storage is available.",
      );
  }, []);
  const markVerified = useCallback((value: boolean) => {
    setSessionVerified(value);
    setVerified(value);
  }, []);

  const signOut = useCallback(async () => {
    const token = currentToken;
    const epoch = advanceAuthGeneration();
    const draftsCleared = clearInvoiceIntents(AsyncStorage);
    currentToken = null;
    validation.current?.abort();
    identity.current = null;
    validatedThisRun.current = false;
    markVerified(false);
    setMe(null);
    setSelectedClientId(null);
    setSessionError(null);
    setStatus("anonymous");
    // Explicit old-token headers ensure delayed cleanup cannot revoke a new login.
    if (token) {
      const headers = { Authorization: "Bearer " + token };
      void logout({ headers }).catch(() => {});
      void SecureStore.getItemAsync(PUSH_TOKEN_KEY)
        .then((pushToken) => {
          if (pushToken)
            return unregisterPushDevice(
              { expoPushToken: pushToken },
              { headers },
            );
        })
        .catch(() => {});
    }
    try {
      await storeInOrder(async () => {
        const results = await Promise.allSettled([
          SecureStore.deleteItemAsync(TOKEN_KEY),
          SecureStore.deleteItemAsync(ME_KEY),
          SecureStore.deleteItemAsync(PUSH_TOKEN_KEY),
          AsyncStorage.removeItem(CLIENT_PARTY_KEY),
          draftsCleared,
        ]);
        if (results.some((result) => result.status === "rejected"))
          throw new Error("Storage cleanup failed");
      });
    } catch {
      if (epoch === getAuthGeneration()) reportStorageFailure();
    }
  }, [markVerified, reportStorageFailure]);

  const revalidate = useCallback(async () => {
    const token = currentToken;
    if (!token) return;
    let epoch = getAuthGeneration();
    validation.current?.abort();
    const controller = new AbortController();
    validation.current = controller;
    markVerified(false);
    setSessionError(null);
    const isCurrent = () =>
      mounted.current &&
      epoch === getAuthGeneration() &&
      !controller.signal.aborted &&
      currentToken === token;
    try {
      const fresh = await getMe({
        signal: controller.signal,
        headers: { Authorization: "Bearer " + token },
      });
      if (!isCurrent()) return;
      if (!fresh || typeof fresh.role !== "string" || !fresh.userId)
        throw new Error("Invalid identity response");
      // Membership and permission changes invalidate all old scoped results.
      const previous = identity.current;
      const scope = (value: Me) =>
        JSON.stringify([
          value.userId,
          value.role,
          value.firmId,
          value.clientPartyId,
          value.buyerPartyId,
          value.capabilities,
          value.features,
        ]);
      if (previous && scope(previous) !== scope(fresh)) {
        epoch = advanceAuthGeneration();
        void clearInvoiceIntents(AsyncStorage).catch(reportStorageFailure);
        setSelectedClientId(null);
        void storeInOrder(() =>
          AsyncStorage.removeItem(CLIENT_PARTY_KEY),
        ).catch(reportStorageFailure);
      }
      identity.current = fresh;
      validatedThisRun.current = true;
      setMe(fresh);
      markVerified(true);
      setStatus("authenticated");
      void storeInOrder(async () => {
        if (epoch === getAuthGeneration())
          await SecureStore.setItemAsync(
            ME_KEY,
            JSON.stringify({ ...fresh, token: undefined }),
          );
      }).catch(() => {
        if (isCurrent()) reportStorageFailure();
      });
    } catch (error) {
      if (!isCurrent()) return;
      if (hasStatus(error, 401) || hasStatus(error, 403)) {
        await signOut();
      } else {
        setSessionError(
          "Could not verify your sign-in. Connect to the internet and try again before making changes.",
        );
        // Only retain read views that were actually validated during this run.
        setStatus(validatedThisRun.current ? "authenticated" : "loading");
      }
    }
  }, [markVerified, reportStorageFailure, signOut]);

  useEffect(() => {
    mounted.current = true;
    const epoch = getAuthGeneration();
    let active = true;
    setUnauthorizedHandler(() => {
      if (currentToken) void signOut();
    });
    void (async () => {
      try {
        await storageQueue;
        const [token, storedClient] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY),
          AsyncStorage.getItem(CLIENT_PARTY_KEY),
        ]);
        if (!active || epoch !== getAuthGeneration()) return;
        if (!token) {
          currentToken = null;
          markVerified(false);
          setStatus("anonymous");
          return;
        }
        currentToken = token;
        setSelectedClientId(storedClient);
        // Cached identity is never used to restore authorization.
        await revalidate();
      } catch {
        if (active && epoch === getAuthGeneration()) {
          reportStorageFailure();
          setStatus("anonymous");
        }
      }
    })();
    const state = AppState.addEventListener("change", (next) => {
      if (next === "active") void revalidate();
      else {
        markVerified(false);
        validation.current?.abort();
      }
    });
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) void revalidate();
      else markVerified(false);
    });
    return () => {
      active = false;
      mounted.current = false;
      validation.current?.abort();
      setUnauthorizedHandler(null);
      state.remove();
      unsubscribe();
    };
  }, [markVerified, revalidate, reportStorageFailure, signOut]);

  const signIn = useCallback(
    async (nextMe: Me) => {
      const token = nextMe.token;
      if (!token)
        throw new Error("Sign-in response did not include an auth token.");
      const epoch = advanceAuthGeneration();
      const draftsCleared = clearInvoiceIntents(AsyncStorage);
      validation.current?.abort();
      currentToken = token;
      identity.current = nextMe;
      validatedThisRun.current = true;
      setMe(nextMe);
      setSelectedClientId(null);
      setPersistenceError(null);
      setSessionError(null);
      markVerified(true);
      setStatus("authenticated");
      try {
        await storeInOrder(async () => {
          if (epoch !== getAuthGeneration()) return;
          await draftsCleared;
          await AsyncStorage.removeItem(CLIENT_PARTY_KEY);
          await SecureStore.setItemAsync(
            ME_KEY,
            JSON.stringify({ ...nextMe, token: undefined }),
          );
          await SecureStore.setItemAsync(TOKEN_KEY, token);
        });
      } catch {
        if (epoch === getAuthGeneration()) reportStorageFailure();
      }
    },
    [markVerified, reportStorageFailure],
  );

  const selectClient = useCallback(
    async (partyId: string) => {
      if (!verified) return;
      const epoch = advanceAuthGeneration();
      markVerified(true);
      const draftsCleared = clearInvoiceIntents(AsyncStorage);
      setSelectedClientId(partyId);
      try {
        await storeInOrder(async () => {
          await draftsCleared;
          if (epoch === getAuthGeneration())
            await AsyncStorage.setItem(CLIENT_PARTY_KEY, partyId);
        });
      } catch {
        if (epoch === getAuthGeneration()) reportStorageFailure();
      }
    },
    [verified, markVerified, reportStorageFailure],
  );

  const switchClient = useCallback(async () => {
    advanceAuthGeneration();
    markVerified(true);
    const draftsCleared = clearInvoiceIntents(AsyncStorage);
    setSelectedClientId(null);
    void queryClient.cancelQueries();
    queryClient.clear();
    try {
      await storeInOrder(async () => {
        await draftsCleared;
        await AsyncStorage.removeItem(CLIENT_PARTY_KEY);
      });
    } catch {
      reportStorageFailure();
    }
  }, [markVerified, reportStorageFailure]);

  const setPushToken = useCallback(
    async (token: string | null) => {
      const epoch = getAuthGeneration();
      try {
        await storeInOrder(async () => {
          if (epoch !== getAuthGeneration()) return;
          if (token) await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
          else await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
        });
      } catch {
        if (epoch === getAuthGeneration()) reportStorageFailure();
      }
    },
    [reportStorageFailure],
  );
  const getPushToken = useCallback(async () => {
    try {
      return await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
    } catch {
      reportStorageFailure();
      return null;
    }
  }, [reportStorageFailure]);

  const clientPartyId = me?.clientPartyId ?? selectedClientId;
  const needsClientSelection =
    status === "authenticated" && !me?.clientPartyId && !selectedClientId;
  const value = useMemo<SessionContextValue>(
    () => ({
      status,
      me,
      clientPartyId,
      needsClientSelection,
      verified,
      persistenceError,
      revalidate,
      signIn,
      signOut,
      selectClient,
      switchClient,
      setPushToken,
      getPushToken,
    }),
    [
      status,
      me,
      clientPartyId,
      needsClientSelection,
      verified,
      persistenceError,
      revalidate,
      signIn,
      signOut,
      selectClient,
      switchClient,
      setPushToken,
      getPushToken,
    ],
  );

  return (
    <SessionContext.Provider value={value}>
      {(sessionError || persistenceError) && (
        <View style={{ padding: 16, backgroundColor: palette.warningSoft }}>
          <Text accessibilityRole="alert" style={{ color: palette.warning }}>
            {sessionError ?? persistenceError}
          </Text>
          {sessionError && (
            <Button
              title="Try again"
              onPress={() => void revalidate()}
              color={palette.primary}
            />
          )}
          {sessionError && status === "loading" && (
            <Button
              title="Sign out"
              onPress={() => void signOut()}
              color={palette.primary}
            />
          )}
        </View>
      )}
      {!(sessionError && status === "loading") && children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSession must be used within a SessionProvider");
  return ctx;
}
