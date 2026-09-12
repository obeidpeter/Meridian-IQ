import { UnsavedWorkController } from "./unsaved-work-controller";

export interface NavigationOptions {
  replace?: boolean;
  state?: unknown;
  transition?: boolean;
}

const marker = "__valo_navigation_v1";
interface EntryState {
  [marker]: { index: number; value: unknown };
}

function entryState(state: unknown): EntryState[typeof marker] | undefined {
  if (!state || typeof state !== "object" || !(marker in state))
    return undefined;
  const entry = (state as EntryState)[marker];
  if (entry && Number.isSafeInteger(entry.index)) return entry;
  return undefined;
}

export interface NavigationSnapshot {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
}

/** A wouter-compatible history owner, without patching global history methods.
 * History stores an opaque position and the caller's original state. Forms are
 * never serialized. Consumers needing history state use the protected hook.
 */
export class ProtectedNavigation {
  readonly work = new UnsavedWorkController();
  private listeners = new Set<() => void>();
  private snapshot: NavigationSnapshot;
  private index: number;
  private started = false;
  private restoring = false;
  private replayIndex: number | null = null;
  private restoredAction: (() => void) | null = null;

  constructor(private host: Window) {
    this.index = entryState(host.history.state)?.index ?? 0;
    this.snapshot = this.read();
  }

  private read(): NavigationSnapshot {
    const { pathname, search, hash } = this.host.location;
    const entry = entryState(this.host.history.state);
    return {
      pathname,
      search,
      hash,
      state: entry ? entry.value : this.host.history.state,
    };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;

  private commit() {
    this.snapshot = this.read();
    this.listeners.forEach((listener) => listener());
  }

  start = () => {
    if (this.started) return () => {};
    this.started = true;
    if (!entryState(this.host.history.state)) {
      this.host.history.replaceState(
        { [marker]: { index: this.index, value: this.host.history.state } },
        "",
      );
    }
    this.host.addEventListener("popstate", this.onPop);
    this.host.addEventListener("beforeunload", this.onUnload);
    return () => {
      this.started = false;
      this.host.removeEventListener("popstate", this.onPop);
      this.host.removeEventListener("beforeunload", this.onUnload);
      this.work.stay();
      this.restoredAction = null;
      this.replayIndex = null;
    };
  };

  private onUnload = (event: BeforeUnloadEvent) => {
    if (!this.work.isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  private afterRestore(action: () => void) {
    if (this.restoring) this.restoredAction = action;
    else action();
  }

  private onPop = () => {
    const entry = entryState(this.host.history.state);
    if (!entry) {
      if (
        this.host.location.pathname === this.snapshot.pathname &&
        this.host.location.search === this.snapshot.search
      ) {
        // Native same-page anchors do not leave the editor, but create history
        // entries too. Give them positions so subsequent traversal is reversible.
        this.index += 1;
        this.host.history.replaceState(
          { [marker]: { index: this.index, value: this.host.history.state } },
          "",
        );
        this.commit();
        return;
      }
      // Entries from before this router was mounted have no known traversal
      // distance. A document navigation uses the browser's unload safeguard.
      this.host.location.reload();
      return;
    }
    if (entry.index === this.index) {
      this.restoring = false;
      this.commit();
      const action = this.restoredAction;
      this.restoredAction = null;
      action?.();
      return;
    }
    if (
      entry.index === this.replayIndex ||
      (!this.work.isDirty() && !this.work.getSnapshot())
    ) {
      this.replayIndex = null;
      this.index = entry.index;
      this.commit();
      return;
    }
    const target = entry.index;
    this.restoring = true;
    this.host.history.go(this.index - target);
    this.work.request((isCurrent) =>
      this.afterRestore(() => {
        if (!isCurrent()) return;
        this.replayIndex = target;
        this.host.history.go(target - this.index);
      }),
    );
  };

  navigate = (to: string | URL, options: NavigationOptions = {}) => {
    const url = new URL(to, this.host.location.href);
    if (url.origin !== this.host.location.origin) {
      this.work.request((isCurrent) =>
        this.afterRestore(() => {
          if (!isCurrent()) return;
          if (options.replace) this.host.location.replace(url.href);
          else this.host.location.assign(url.href);
        }),
      );
      return;
    }
    const destination = url.pathname + url.search + url.hash;
    const current =
      this.snapshot.pathname + this.snapshot.search + this.snapshot.hash;
    if (
      destination === current &&
      (options.state === undefined ||
        Object.is(options.state, this.snapshot.state))
    )
      return;
    this.work.request((isCurrent) =>
      this.afterRestore(() => {
        if (!isCurrent()) return;
        const index = this.index + (options.replace ? 0 : 1);
        this.host.history[options.replace ? "replaceState" : "pushState"](
          { [marker]: { index, value: options.state ?? null } },
          "",
          destination,
        );
        this.index = index;
        this.commit();
      }),
    );
  };
}
