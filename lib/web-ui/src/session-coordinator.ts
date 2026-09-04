export type SignOutResult = "confirmed" | "local-only";
export const SESSION_EVENT_KEY = "meridianiq:session-event";
const CHANNEL = "meridianiq-session";

interface SessionClient {
  cancelQueries: () => Promise<unknown>;
  clear: () => void;
}
interface SessionEvent {
  type: "sign-out";
  id: string;
  phase?: "pending" | "replaced" | SignOutResult;
  startedAt?: number;
}

export function clearSessionStorage(getStorage: () => Storage): void {
  try {
    const storage = getStorage();
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith("meridianiq:") && key !== SESSION_EVENT_KEY) {
        try {
          storage.removeItem(key);
        } catch {
          /* Continue with other keys. */
        }
      }
    }
  } catch {
    /* Storage getters themselves can throw in restricted browsers. */
  }
}

export async function clearLegacySessionCaches(): Promise<void> {
  try {
    const storage = window.caches;
    if (!storage) return;
    const keys = await storage.keys();
    await Promise.all(
      keys
        .filter((key) => /^meridianiq-v\d+$/.test(key))
        .map((key) => storage.delete(key).catch(() => false)),
    );
  } catch {
    /* CacheStorage is optional; never block local sign-out. */
  }
}

function readEvent(): string | null {
  try {
    return window.localStorage.getItem(SESSION_EVENT_KEY);
  } catch {
    return null;
  }
}

export function createSessionCoordinator() {
  const clients = new Set<SessionClient>();
  const listeners = new Set<() => void>();
  const mutations = new WeakMap<object, number>();
  let generation = 0;
  let ending = false;
  let pending: Promise<SignOutResult> | null = null;
  let channel: BroadcastChannel | null = null;
  let seenEvent: string | null = null;
  let disconnect: (() => void) | null = null;
  let remoteTimer: ReturnType<typeof setTimeout> | undefined;
  let remoteCleanup: Promise<void> | undefined;
  const eventKey = (event: SessionEvent) =>
    event.id + ":" + (event.phase ?? "local-only");
  const broadcast = (event: SessionEvent) => {
    seenEvent = eventKey(event);
    try {
      channel?.postMessage(event);
    } catch {
      /* storage fallback below */
    }
    try {
      window.localStorage.setItem(SESSION_EVENT_KEY, JSON.stringify(event));
    } catch {
      /* optional */
    }
  };

  const cleanup = async () => {
    // Cancellation invalidates queries synchronously even when their fetch
    // ignores AbortSignal. Clear before yielding; never reset/refetch identity.
    const cancellations = [...clients].map((client) => {
      const cancelled = client.cancelQueries().catch(() => {});
      client.clear();
      return cancelled;
    });
    clearSessionStorage(() => window.localStorage);
    clearSessionStorage(() => window.sessionStorage);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...cancellations, clearLegacySessionCaches()]),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 2_000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    clients.forEach((client) => client.clear());
  };
  const endLocal = () => {
    generation++;
    ending = true;
    listeners.forEach((listener) => listener());
    return cleanup();
  };
  const receive = (raw: unknown) => {
    let event: SessionEvent;
    try {
      event = (typeof raw === "string" ? JSON.parse(raw) : raw) as SessionEvent;
    } catch {
      return;
    }
    if (
      !event ||
      event.type !== "sign-out" ||
      typeof event.id !== "string" ||
      eventKey(event) === seenEvent ||
      pending
    )
      return;
    seenEvent = eventKey(event);
    remoteCleanup ??= endLocal();
    clearTimeout(remoteTimer);
    const navigate = (confirmed: boolean) => {
      void remoteCleanup?.finally(() =>
        window.location.replace(
          "/login?reason=" + (confirmed ? "signed-out" : "local-signout"),
        ),
      );
    };
    if (event.phase === "pending") {
      // A new login must not race an outstanding Set-Cookie logout response.
      const elapsed =
        typeof event.startedAt === "number"
          ? Math.max(0, Date.now() - event.startedAt)
          : 0;
      remoteTimer = setTimeout(
        () => navigate(false),
        Math.max(0, 12_000 - elapsed),
      );
    } else if (event.phase === "replaced") {
      void remoteCleanup.finally(() => window.location.replace("/login"));
    } else {
      navigate(event.phase === "confirmed");
    }
  };
  const connect = () => {
    if (disconnect || typeof window === "undefined") return;
    const stored = readEvent();
    try {
      const event: SessionEvent | null = stored ? JSON.parse(stored) : null;
      seenEvent = event ? eventKey(event) : null;
      if (event?.phase === "pending") {
        seenEvent = null;
        receive(event);
      }
    } catch {
      seenEvent = null;
    }
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => receive(event.data);
    } catch {
      channel = null;
    }
    const storage = (event: StorageEvent) => {
      if (event.key === SESSION_EVENT_KEY && event.newValue)
        receive(event.newValue);
    };
    const resume = () => {
      const event = readEvent();
      if (event) receive(event);
    };
    window.addEventListener("storage", storage);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    disconnect = () => {
      clearTimeout(remoteTimer);
      channel?.close();
      channel = null;
      window.removeEventListener("storage", storage);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
      disconnect = null;
    };
  };
  return {
    async startSession(): Promise<boolean> {
      const epoch = ++generation;
      await cleanup();
      if (ending || epoch !== generation) return false;
      broadcast({
        type: "sign-out",
        id: Date.now() + "-" + Math.random(),
        phase: "replaced",
      });
      return true;
    },
    mutationCacheOptions: {
      onMutate: (_variables: unknown, mutation: object) => {
        if (ending) throw new Error("This session has ended.");
        mutations.set(mutation, generation);
      },
      onSuccess: (
        _data: unknown,
        _variables: unknown,
        _context: unknown,
        mutation: object,
      ) => {
        if (ending || mutations.get(mutation) !== generation)
          throw new Error("This request belongs to a previous session.");
      },
    },
    getGeneration: () => generation,
    isEnding: () => ending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attach(client: SessionClient) {
      clients.add(client);
      connect();
      if (ending) void cleanup();
      return () => {
        clients.delete(client);
        if (!clients.size) disconnect?.();
      };
    },
    signOut(
      request: (signal: AbortSignal) => Promise<unknown>,
    ): Promise<SignOutResult> {
      if (pending) return pending;
      const controller = new AbortController();
      // Start revocation before React unmounts protected content.
      let revoke: Promise<unknown>;
      try {
        revoke = request(controller.signal);
      } catch (error) {
        revoke = Promise.reject(error);
      }
      const cleared = endLocal();
      const event: SessionEvent = {
        type: "sign-out",
        id: Date.now() + "-" + Math.random(),
        phase: "pending",
        startedAt: Date.now(),
      };
      broadcast(event);
      pending = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: SignOutResult = "local-only";
        try {
          await Promise.race([
            revoke,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error("Logout timed out"));
              }, 10_000);
            }),
          ]);
          result = "confirmed";
        } catch {
          /* Local cleanup is independent of server availability. */
        } finally {
          clearTimeout(timer);
        }
        await cleared;
        broadcast({ ...event, phase: result });
        return result;
      })();
      return pending;
    },
  };
}

export const webSession = createSessionCoordinator();

export async function expireSession(): Promise<void> {
  const returnTo = encodeURIComponent(
    window.location.pathname + window.location.search,
  );
  await webSession.signOut(() => Promise.resolve());
  window.location.replace("/login?reason=expired&returnTo=" + returnTo);
}

export async function signOutAndRedirect(
  request: (signal: AbortSignal) => Promise<unknown>,
): Promise<SignOutResult> {
  const result = await webSession.signOut(request);
  window.location.replace(
    "/login?reason=" +
      (result === "confirmed" ? "signed-out" : "local-signout"),
  );
  return result;
}
