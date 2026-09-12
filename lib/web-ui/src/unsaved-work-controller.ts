export interface UnsavedWorkHandler {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => boolean;
  saveDisabledReason?: () => string | null | undefined;
}

export interface UnsavedWorkPrompt {
  busy: boolean;
  error: string | null;
}

/** Owns one pending destination. Handlers and drafts remain in memory only. */
export class UnsavedWorkController {
  private handlers = new Set<UnsavedWorkHandler>();
  private listeners = new Set<() => void>();
  private pending: {
    proceed: (isCurrent: () => boolean) => void;
    handlers: UnsavedWorkHandler[];
  } | null = null;
  private prompt: UnsavedWorkPrompt | null = null;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.prompt;
  isDirty = () => [...this.handlers].some((handler) => handler.isDirty());

  private publish(prompt: UnsavedWorkPrompt | null) {
    this.prompt = prompt;
    this.listeners.forEach((listener) => listener());
  }

  register(handler: UnsavedWorkHandler) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
      // Identity/permission changes must never replay an old destination or save.
      if (this.pending?.handlers.includes(handler)) this.stay();
    };
  }

  request = (proceed: (isCurrent: () => boolean) => void) => {
    if (this.pending) return;
    const handlers = [...this.handlers].filter((handler) => handler.isDirty());
    if (!handlers.length) return proceed(() => true);
    this.pending = { proceed, handlers };
    this.publish({ busy: false, error: null });
  };

  stay = () => {
    this.pending = null;
    this.publish(null);
  };

  save = async () => {
    const pending = this.pending;
    if (!pending || this.prompt?.busy) return;
    this.publish({ busy: true, error: null });
    try {
      for (const handler of pending.handlers) {
        if (this.pending !== pending) return;
        const disabled = handler.saveDisabledReason?.();
        if (disabled) throw new Error(disabled);
        if (handler.isDirty() && !(await handler.save())) {
          if (this.pending === pending) {
            this.publish({
              busy: false,
              error:
                "Changes were not saved. Stay on this page to review the form, or try saving again.",
            });
          }
          return;
        }
      }
      if (this.pending !== pending) return;
      this.stay();
      pending.proceed(() =>
        pending.handlers.every((handler) => this.handlers.has(handler)),
      );
    } catch (error) {
      if (this.pending === pending) {
        this.publish({
          busy: false,
          error:
            error instanceof Error
              ? error.message
              : "Changes could not be saved. Your edits are still here.",
        });
      }
    }
  };

  discard = () => {
    const pending = this.pending;
    if (!pending || this.prompt?.busy) return;
    if (pending.handlers.some((handler) => !handler.discard())) {
      this.publish({
        busy: false,
        error:
          "A save is still running. Wait for it to finish before discarding.",
      });
      return;
    }
    this.stay();
    pending.proceed(() =>
      pending.handlers.every((handler) => this.handlers.has(handler)),
    );
  };
}
