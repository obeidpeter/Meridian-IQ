// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { ProtectedNavigation } from "./protected-navigation";

// A deterministic asynchronous history port exercises traversal ordering without
// jsdom's cross-test history stack and timer-dependent Back implementation.
function browser() {
  const events = new EventTarget();
  const entries = [
    { url: "https://valo.test/app/home?first=1", state: null as unknown },
  ];
  const traversals: number[] = [];
  let position = 0;
  const reload = vi.fn(() => {
    const event = new Event("beforeunload", { cancelable: true });
    events.dispatchEvent(event);
    return event.defaultPrevented;
  });
  const host = {
    get location() {
      return Object.assign(new URL(entries[position].url), { reload });
    },
    history: {
      get state() {
        return entries[position].state;
      },
      pushState(state: unknown, _title: string, url?: string) {
        entries.splice(position + 1);
        entries.push({
          state,
          url: new URL(url ?? entries[position].url, entries[position].url)
            .href,
        });
        position += 1;
      },
      replaceState(state: unknown, _title: string, url?: string) {
        entries[position] = {
          state,
          url: new URL(url ?? entries[position].url, entries[position].url)
            .href,
        };
      },
      go(delta: number) {
        traversals.push(delta);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;
  function flushOne() {
    if (traversals.length) {
      position += traversals.shift()!;
      if (position < 0 || position >= entries.length)
        throw new Error("Invalid history traversal");
      events.dispatchEvent(new Event("popstate"));
    }
  }
  function flush() {
    while (traversals.length) flushOne();
  }
  return {
    host,
    entries,
    events,
    reload,
    flush,
    flushOne,
    get position() {
      return position;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

test.each([null, "route-state", 42, false, { nested: ["a", 1] }])(
  "push and replace preserve URL and caller state %s",
  (state) => {
    const { host, entries } = browser();
    const navigation = new ProtectedNavigation(host);
    const stop = navigation.start();
    navigation.navigate("/app/business?tab=tax#city", { state });
    expect(navigation.getSnapshot()).toEqual({
      pathname: "/app/business",
      search: "?tab=tax",
      hash: "#city",
      state,
    });
    navigation.navigate("/app/business?tab=address", { replace: true, state });
    expect(entries).toHaveLength(2);
    expect(navigation.getSnapshot().state).toEqual(state);
    expect(navigation.getSnapshot().search).toBe("?tab=address");
    stop();
  },
);

test("a cancelled programmatic replacement changes neither history nor search", () => {
  const { host, entries } = browser();
  const navigation = new ProtectedNavigation(host);
  navigation.start();
  navigation.work.register({
    isDirty: () => true,
    save: async () => false,
    discard: () => true,
  });
  navigation.navigate("/app/business?next=1", {
    replace: true,
    state: { from: "home" },
  });
  navigation.work.stay();
  expect(entries).toHaveLength(1);
  expect(navigation.getSnapshot().search).toBe("?first=1");
  expect(host.location.pathname).toBe("/app/home");
});

test("Back restores URL while blocked, Stay retains history, Discard replays the exact entry, Forward is also guarded", () => {
  const b = browser();
  const navigation = new ProtectedNavigation(b.host);
  navigation.start();
  navigation.navigate("/app/business?edit=1", { state: "business-state" });
  navigation.navigate("/app/third?next=1", { state: { page: 3 } });
  let dirty = true;
  navigation.work.register({
    isDirty: () => dirty,
    save: async () => false,
    discard: () => {
      dirty = false;
      return true;
    },
  });
  b.host.history.go(-2);
  b.flush();
  expect(b.position).toBe(2);
  expect(navigation.getSnapshot().pathname).toBe("/app/third");
  expect(b.host.location.pathname).toBe("/app/third");
  navigation.work.stay();
  expect(b.entries).toHaveLength(3);
  b.host.history.go(-1);
  b.flush();
  navigation.work.discard();
  b.flush();
  expect(b.position).toBe(1);
  expect(navigation.getSnapshot()).toMatchObject({
    search: "?edit=1",
    state: "business-state",
  });
  dirty = true;
  b.host.history.go(1);
  b.flush();
  expect(b.position).toBe(1);
  expect(navigation.work.getSnapshot()).not.toBeNull();
  navigation.work.discard();
  b.flush();
  expect(navigation.getSnapshot().state).toEqual({ page: 3 });
});

test("a save failure after Back retains input owner and URL; confirmed retry alone releases traversal", async () => {
  const b = browser();
  const navigation = new ProtectedNavigation(b.host);
  navigation.start();
  navigation.navigate("/app/business?edit=1");
  const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  navigation.work.register({ isDirty: () => true, save, discard: () => true });
  b.host.history.go(-1);
  b.flush();
  await navigation.work.save();
  b.flush();
  expect(b.position).toBe(1);
  await navigation.work.save();
  b.flush();
  expect(b.position).toBe(0);
  expect(navigation.getSnapshot().search).toBe("?first=1");
});

test("an immediate decision waits for restoration and repeated Back does not replace its destination", () => {
  const b = browser();
  const navigation = new ProtectedNavigation(b.host);
  navigation.start();
  navigation.navigate("/app/business");
  navigation.work.register({
    isDirty: () => true,
    save: async () => true,
    discard: () => true,
  });
  const unsubscribe = navigation.work.subscribe(() => {
    if (navigation.work.getSnapshot()) navigation.work.discard();
  });
  b.host.history.go(-1);
  b.flush();
  unsubscribe();
  expect(b.position).toBe(0);
  expect(navigation.getSnapshot().pathname).toBe("/app/home");
});

test("unload warning and listeners are removed when the provider stops", () => {
  const b = browser();
  const navigation = new ProtectedNavigation(b.host);
  const stop = navigation.start();
  const unregister = navigation.work.register({
    isDirty: () => true,
    save: async () => false,
    discard: () => true,
  });
  const warned = () => {
    const event = new Event("beforeunload", { cancelable: true });
    b.events.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(warned()).toBe(true);
  unregister();
  expect(warned()).toBe(false);
  navigation.work.register({
    isDirty: () => true,
    save: async () => false,
    discard: () => true,
  });
  stop();
  expect(warned()).toBe(false);
});

test.each([false, true])(
  "untracked pre-router Back uses reload/unload fallback without accepting the unknown route (dirty=%s)",
  (dirty) => {
    const b = browser();
    b.host.history.pushState(
      "initial-business-state",
      "",
      "/app/business?tab=tax",
    );
    const navigation = new ProtectedNavigation(b.host);
    navigation.start();
    navigation.work.register({
      isDirty: () => dirty,
      save: async () => false,
      discard: () => true,
    });
    b.host.history.go(-1);
    b.flush();
    expect(b.reload).toHaveBeenCalledOnce();
    expect(b.reload.mock.results[0].value).toBe(dirty);
    expect(navigation.getSnapshot()).toMatchObject({
      pathname: "/app/business",
      search: "?tab=tax",
      state: "initial-business-state",
    });
    // Refusing the native reload retains the component but cannot undo an
    // unknown traversal. Returning Forward restores its owned address/entry.
    b.host.history.go(1);
    b.flush();
    expect(b.host.location.pathname).toBe("/app/business");
  },
);

test("a reload resumes opaque entry positions without losing caller state", () => {
  const b = browser();
  const first = new ProtectedNavigation(b.host);
  const stop = first.start();
  first.navigate("/app/business?tab=tax", { state: { selection: 7 } });
  stop();
  const resumed = new ProtectedNavigation(b.host);
  resumed.start();
  expect(resumed.getSnapshot().state).toEqual({ selection: 7 });
  resumed.work.register({
    isDirty: () => true,
    save: async () => false,
    discard: () => true,
  });
  b.host.history.go(-1);
  b.flush();
  expect(b.position).toBe(1);
  expect(resumed.work.getSnapshot()).not.toBeNull();
});

test("same-entry query notifications synchronize the accepted search snapshot", () => {
  const b = browser();
  const navigation = new ProtectedNavigation(b.host);
  navigation.start();
  b.host.history.replaceState(
    b.host.history.state,
    "",
    "/app/home?filter=open#results",
  );
  b.events.dispatchEvent(new Event("popstate"));
  expect(navigation.getSnapshot()).toMatchObject({
    search: "?filter=open",
    hash: "#results",
  });
});

test.each(["save", "discard"] as const)(
  "%s approved before restoration cannot navigate after the owner changes",
  async (choice) => {
    const b = browser();
    const navigation = new ProtectedNavigation(b.host);
    navigation.start();
    navigation.navigate("/app/business?tab=tax");
    const unregister = navigation.work.register({
      isDirty: () => true,
      save: async () => true,
      discard: () => true,
    });
    b.host.history.go(-1);
    b.flushOne();
    expect(b.position).toBe(0);
    await navigation.work[choice]();
    unregister();
    navigation.work.register({
      isDirty: () => false,
      save: async () => true,
      discard: () => true,
    });
    b.flush();
    expect(b.position).toBe(1);
    expect(navigation.getSnapshot().pathname).toBe("/app/business");
    expect(navigation.work.getSnapshot()).toBeNull();
  },
);
