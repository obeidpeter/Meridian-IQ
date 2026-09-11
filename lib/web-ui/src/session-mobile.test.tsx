// @vitest-environment jsdom
import React from "react";
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  secure: new Map<string, string>(),
  ordinary: new Map<string, string>(),
  getMe: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  appState: null as null | ((state: string) => void),
  network: null as null | ((state: { isConnected: boolean }) => void),
}));
vi.mock(
  "../../../artifacts/mobile/node_modules/@workspace/api-client-react",
  () => ({
    getMe: mocks.getMe,
    logout: vi.fn(async () => {}),
    unregisterPushDevice: vi.fn(async () => {}),
    setAuthTokenGetter: vi.fn(),
  }),
);
vi.mock("../../../artifacts/mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: mocks.get,
  setItemAsync: mocks.set,
  deleteItemAsync: mocks.remove,
}));
vi.mock(
  "../../../artifacts/mobile/node_modules/@react-native-async-storage/async-storage",
  () => ({
    default: {
      getItem: async (key: string) => mocks.ordinary.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        mocks.ordinary.set(key, value);
      },
      removeItem: async (key: string) => {
        mocks.ordinary.delete(key);
      },
      getAllKeys: async () => [...mocks.ordinary.keys()],
      multiRemove: async (keys: string[]) => {
        keys.forEach((key) => mocks.ordinary.delete(key));
      },
    },
  }),
);
vi.mock("../../../artifacts/mobile/node_modules/expo-network", () => ({
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: (callback: typeof mocks.network) => {
    mocks.network = callback;
    return { remove() {} };
  },
}));
vi.mock("../../../artifacts/mobile/node_modules/react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    addEventListener: (_name: string, callback: typeof mocks.appState) => {
      mocks.appState = callback;
      return { remove() {} };
    },
  },
  useColorScheme: () => "light",
  View: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  Button: ({ title, onPress }: { title: string; onPress: () => void }) => (
    <button onClick={onPress}>{title}</button>
  ),
}));
import {
  SessionProvider,
  useSession,
} from "../../../artifacts/mobile/lib/session";
import {
  advanceAuthGeneration,
  guardSessionFetch,
  queryClient,
  setSessionVerified,
  setUnauthorizedHandler,
} from "../../../artifacts/mobile/lib/query";

const identity = (userId = "A") => ({
  userId,
  role: "client_user",
  clientPartyId: userId + "-party",
  capabilities: ["invoice.write"],
  features: [],
  token: userId + "-token",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  mocks.secure.clear();
  mocks.ordinary.clear();
  mocks.getMe.mockReset();
  mocks.get
    .mockReset()
    .mockImplementation(async (key: string) => mocks.secure.get(key) ?? null);
  mocks.set
    .mockReset()
    .mockImplementation(async (key: string, value: string) => {
      mocks.secure.set(key, value);
    });
  mocks.remove.mockReset().mockImplementation(async (key: string) => {
    mocks.secure.delete(key);
  });
  advanceAuthGeneration();
});
afterEach(() => {
  cleanup();
  setUnauthorizedHandler(null);
  queryClient.clear();
});

test("startup never exposes cached authorization and validates revoked sessions immediately", async () => {
  mocks.secure.set("miq_token", "A-token");
  mocks.secure.set("miq_me", JSON.stringify(identity()));
  const fresh = deferred<ReturnType<typeof identity>>();
  mocks.getMe.mockReturnValue(fresh.promise);
  const { result } = renderHook(useSession, { wrapper: SessionProvider });
  await vi.waitFor(() => expect(mocks.getMe).toHaveBeenCalledOnce());
  expect(result.current.status).toBe("loading");
  expect(result.current.me).toBeNull();
  await act(async () => {
    fresh.reject({ status: 401 });
  });
  await vi.waitFor(() => expect(result.current.status).toBe("anonymous"));
  expect(mocks.secure.has("miq_token")).toBe(false);
});

test("a stale startup identity cannot overwrite a new login", async () => {
  mocks.secure.set("miq_token", "A-token");
  const old = deferred<ReturnType<typeof identity>>();
  mocks.getMe.mockReturnValue(old.promise);
  const { result } = renderHook(useSession, { wrapper: SessionProvider });
  await vi.waitFor(() => expect(mocks.getMe).toHaveBeenCalledOnce());
  await act(async () => {
    await result.current.signIn(identity("B"));
  });
  await act(async () => {
    old.resolve(identity("A"));
  });
  expect(result.current.me?.userId).toBe("B");
  expect(mocks.secure.get("miq_token")).toBe("B-token");
});

test("foreground and reconnect revalidate; offline reads cannot mutate", async () => {
  mocks.secure.set("miq_token", "A-token");
  mocks.getMe.mockResolvedValue(identity());
  const { result } = renderHook(useSession, { wrapper: SessionProvider });
  await vi.waitFor(() => expect(result.current.verified).toBe(true));
  act(() => mocks.appState?.("background"));
  expect(result.current.verified).toBe(false);
  const mutate = vi.fn(async () => "saved");
  const mutation = queryClient
    .getMutationCache()
    .build(queryClient, { mutationKey: ["saveInvoice"], mutationFn: mutate });
  await expect(mutation.execute(undefined)).rejects.toThrow(
    "Verify your session",
  );
  expect(mutate).not.toHaveBeenCalled();
  mocks.getMe.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    mocks.appState?.("active");
  });
  expect(result.current.status).toBe("authenticated");
  expect(result.current.verified).toBe(false);
  expect(screen.getByText(/Could not verify your sign-in/)).toBeTruthy();
  await act(async () => {
    mocks.network?.({ isConnected: false });
    mocks.network?.({ isConnected: true });
  });
  await vi.waitFor(() => expect(result.current.verified).toBe(true));
  expect(mocks.getMe).toHaveBeenCalledTimes(3);
});

test("a slow secure write is erased by logout without erasing a later login", async () => {
  const { result } = renderHook(useSession, { wrapper: SessionProvider });
  await vi.waitFor(() => expect(result.current.status).toBe("anonymous"));
  const write = deferred<void>();
  mocks.set.mockImplementationOnce(async (key: string, value: string) => {
    await write.promise;
    mocks.secure.set(key, value);
  });
  let first!: Promise<void>;
  act(() => {
    first = result.current.signIn(identity("A"));
  });
  await vi.waitFor(() => expect(mocks.set).toHaveBeenCalled());
  let out!: Promise<void>;
  let second!: Promise<void>;
  act(() => {
    out = result.current.signOut();
    second = result.current.signIn(identity("B"));
  });
  await act(async () => {
    write.resolve();
    await Promise.all([first, out, second]);
  });
  expect(result.current.me?.userId).toBe("B");
  expect(mocks.secure.get("miq_token")).toBe("B-token");
});

test("persistence failures are visible without exposing bearer material", async () => {
  const { result } = renderHook(useSession, { wrapper: SessionProvider });
  await vi.waitFor(() => expect(result.current.status).toBe("anonymous"));
  mocks.set.mockRejectedValue(new Error("secret-token-material"));
  await act(async () => {
    await result.current.signIn(identity());
  });
  expect(result.current.status).toBe("authenticated");
  expect(result.current.persistenceError).toContain("Secure session storage");
  expect(screen.queryByText(/secret-token-material/)).toBeNull();
});

test("old mutation success and 401 cannot affect the next auth generation", async () => {
  setSessionVerified(true);
  const late = deferred<string>();
  const success = vi.fn();
  const unauthorized = vi.fn();
  setUnauthorizedHandler(unauthorized);
  const mutation = queryClient
    .getMutationCache()
    .build(queryClient, { mutationFn: () => late.promise, onSuccess: success });
  const pending = mutation.execute(undefined).catch((error) => error);
  await vi.waitFor(() => expect(mutation.state.status).toBe("pending"));
  advanceAuthGeneration();
  late.resolve("A data");
  expect(await pending).toBeInstanceOf(Error);
  expect(success).not.toHaveBeenCalled();
  expect(unauthorized).not.toHaveBeenCalled();

  setSessionVerified(true);
  const failed = deferred<string>();
  const old = queryClient
    .getMutationCache()
    .build(queryClient, { mutationFn: () => failed.promise });
  const oldResult = old.execute(undefined).catch(() => {});
  await vi.waitFor(() => expect(old.state.status).toBe("pending"));
  advanceAuthGeneration();
  failed.reject({ status: 401 });
  await oldResult;
  expect(unauthorized).not.toHaveBeenCalled();
});

test("direct API writes are blocked until verified, and late bodies cannot escape the generation guard", async () => {
  const body = deferred<string>();
  const fetcher = vi.fn(async () => new Response("body"));
  const guarded = guardSessionFetch(fetcher);
  await expect(
    guarded("https://fixture.invalid/api/invoices", { method: "POST" }),
  ).rejects.toThrow("Verify your session");
  expect(fetcher).not.toHaveBeenCalled();
  setSessionVerified(true);
  const response = new Response("private");
  Object.defineProperty(response, "text", {
    configurable: true,
    value: () => body.promise,
  });
  fetcher.mockResolvedValueOnce(response);
  const received = await guarded("https://fixture.invalid/api/me");
  const parsed = received.text().catch((error) => error);
  advanceAuthGeneration();
  body.resolve("old identity");
  expect(await parsed).toBeInstanceOf(Error);
});
