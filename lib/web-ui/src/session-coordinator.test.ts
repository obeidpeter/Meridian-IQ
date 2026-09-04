import { afterEach, expect, test, vi } from "vitest";
import {
  clearSessionStorage,
  createSessionCoordinator,
  SESSION_EVENT_KEY,
} from "./session-coordinator";

function storage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
function browser() {
  const events = new EventTarget();
  const localStorage = storage();
  const sessionStorage = storage();
  const cacheNames = new Set([
    "meridianiq-v1",
    "meridianiq-v3",
    "meridianiq-sme-static-v4",
    "sibling-v1",
  ]);
  const target = {
    localStorage,
    sessionStorage,
    caches: {
      keys: async () => [...cacheNames],
      delete: async (key: string) => cacheNames.delete(key),
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    location: { replace: vi.fn() },
  };
  vi.stubGlobal("window", target);
  vi.stubGlobal(
    "BroadcastChannel",
    class {
      close() {}
      postMessage() {}
    },
  );
  return { ...target, events, cacheNames };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("cleanup handles throwing storage access and preserves unrelated data", () => {
  expect(() =>
    clearSessionStorage(() => {
      throw new Error("blocked");
    }),
  ).not.toThrow();
  const data = storage();
  for (const key of [
    "meridianiq:invoice-draft",
    "meridianiq:recent-x",
    "meridianiq:pinned-x",
    "meridianiq:operations:1",
    "other",
  ])
    data.setItem(key, "private");
  clearSessionStorage(() => data);
  expect(data.length).toBe(1);
  expect(data.getItem("other")).toBe("private");
});

test("logout cancels and clears before network completion, cleans both stores and only legacy caches", async () => {
  const env = browser();
  env.localStorage.setItem("meridianiq:invoice-draft", "A");
  env.sessionStorage.setItem("meridianiq:work-draft:1", "A");
  const coordinator = createSessionCoordinator();
  const client = { cancelQueries: vi.fn(async () => {}), clear: vi.fn() };
  const detach = coordinator.attach(client);
  let finish!: () => void;
  const request = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = coordinator.signOut(request);
  expect(coordinator.isEnding()).toBe(true);
  expect(client.cancelQueries).toHaveBeenCalledOnce();
  expect(client.clear).toHaveBeenCalled();
  expect(env.localStorage.getItem("meridianiq:invoice-draft")).toBeNull();
  expect(env.sessionStorage.length).toBe(0);
  expect(coordinator.signOut(request)).toBe(pending);
  finish();
  expect(await pending).toBe("confirmed");
  expect([...env.cacheNames]).toEqual([
    "meridianiq-sme-static-v4",
    "sibling-v1",
  ]);
  detach();
});

test("failed and timed-out revocations are explicitly local-only even with blocked storage", async () => {
  browser();
  Object.defineProperty(window, "localStorage", {
    get() {
      throw new Error("blocked");
    },
  });
  expect(
    await createSessionCoordinator().signOut(async () => {
      throw new Error("offline");
    }),
  ).toBe("local-only");
  vi.useFakeTimers();
  const coordinator = createSessionCoordinator();
  let signal: AbortSignal | undefined;
  const result = coordinator.signOut((value) => {
    signal = value;
    return new Promise(() => {});
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toBe("local-only");
  expect(signal?.aborted).toBe(true);
});

test("other tabs and resumed pages clear once without re-broadcasting", async () => {
  const env = browser();
  const coordinator = createSessionCoordinator();
  const client = { cancelQueries: vi.fn(async () => {}), clear: vi.fn() };
  const detach = coordinator.attach(client);
  env.localStorage.setItem(
    SESSION_EVENT_KEY,
    JSON.stringify({ type: "sign-out", id: "another-tab" }),
  );
  env.events.dispatchEvent(new Event("pageshow"));
  await vi.waitFor(() =>
    expect(env.location.replace).toHaveBeenCalledWith(
      "/login?reason=local-signout",
    ),
  );
  expect(coordinator.getGeneration()).toBe(1);
  env.events.dispatchEvent(new Event("focus"));
  expect(coordinator.getGeneration()).toBe(1);
  expect(client.clear).toHaveBeenCalled();
  detach();
});

test("late mutation success cannot invoke account-specific success callbacks", async () => {
  browser();
  const coordinator = createSessionCoordinator();
  const mutation = {};
  coordinator.mutationCacheOptions.onMutate(null, mutation);
  await coordinator.signOut(async () => {});
  expect(() =>
    coordinator.mutationCacheOptions.onSuccess(
      { user: "A" },
      null,
      null,
      mutation,
    ),
  ).toThrow("previous session");
});

test("other tabs wait for revocation to finish before offering login", async () => {
  const env = browser();
  const coordinator = createSessionCoordinator();
  const detach = coordinator.attach({
    cancelQueries: async () => {},
    clear() {},
  });
  const event = {
    type: "sign-out",
    id: "pending-tab",
    phase: "pending",
    startedAt: Date.now(),
  };
  env.localStorage.setItem(SESSION_EVENT_KEY, JSON.stringify(event));
  env.events.dispatchEvent(new Event("focus"));
  expect(coordinator.isEnding()).toBe(true);
  await Promise.resolve();
  expect(env.location.replace).not.toHaveBeenCalled();
  env.localStorage.setItem(
    SESSION_EVENT_KEY,
    JSON.stringify({ ...event, phase: "confirmed" }),
  );
  env.events.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(env.location.replace).toHaveBeenCalledWith(
      "/login?reason=signed-out",
    ),
  );
  detach();
});

test("hung CacheStorage cannot hold the user on the sign-out screen", async () => {
  const env = browser();
  env.caches.keys = () => new Promise(() => {});
  vi.useFakeTimers();
  const pending = createSessionCoordinator().signOut(async () => {});
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toBe("confirmed");
});

test("explicit account replacement clears stale state and makes sibling tabs resolve fresh identity", async () => {
  const env = browser();
  const coordinator = createSessionCoordinator();
  const client = { cancelQueries: vi.fn(async () => {}), clear: vi.fn() };
  const detach = coordinator.attach(client);
  env.localStorage.setItem("meridianiq:invoice-draft", "A");
  await coordinator.startSession();
  expect(coordinator.isEnding()).toBe(false);
  expect(coordinator.getGeneration()).toBe(1);
  expect(env.localStorage.getItem("meridianiq:invoice-draft")).toBeNull();
  env.localStorage.setItem(
    SESSION_EVENT_KEY,
    JSON.stringify({ type: "sign-out", phase: "replaced", id: "B" }),
  );
  env.events.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(env.location.replace).toHaveBeenCalledWith("/login"),
  );
  detach();
});
