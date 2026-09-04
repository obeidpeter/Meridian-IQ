import { useCallback, useEffect, useRef } from "react";
import { webSession } from "@workspace/web-ui";

export interface SessionWork {
  readonly id: string;
  readonly scope: string | null;
  readonly signal: AbortSignal;
  current(): boolean;
  check(): void;
  close(): void;
}

/** Capture once before async work; never borrow a newer effect's controller. */
export function useSessionWork(scope: string | null) {
  const owner = useRef(scope);
  owner.current = scope;
  const generation = webSession.getGeneration();
  const active = useRef<{
    scope: string | null;
    generation: number;
    controller: AbortController;
  } | null>(null);
  useEffect(() => {
    const lifetime = { scope, generation, controller: new AbortController() };
    active.current = lifetime;
    const invalidate = () => {
      if (webSession.isEnding() || webSession.getGeneration() !== generation)
        lifetime.controller.abort();
    };
    const unsubscribe = webSession.subscribe(invalidate);
    invalidate();
    return () => {
      lifetime.controller.abort();
      if (active.current === lifetime) active.current = null;
      unsubscribe();
    };
  }, [scope, generation]);
  return useCallback(
    (id: string, valid: () => boolean = () => true): SessionWork => {
      const lifetime = active.current;
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (!lifetime || lifetime.controller.signal.aborted) abort();
      else
        lifetime.controller.signal.addEventListener("abort", abort, {
          once: true,
        });
      const current = () =>
        !!lifetime &&
        active.current === lifetime &&
        owner.current === lifetime.scope &&
        !!lifetime.scope &&
        webSession.getGeneration() === lifetime.generation &&
        !webSession.isEnding() &&
        !controller.signal.aborted &&
        valid();
      return Object.freeze({
        id,
        scope: lifetime?.scope ?? null,
        signal: controller.signal,
        current,
        check() {
          if (!current()) {
            abort();
            throw new DOMException(
              "This work belongs to an inactive session or intent.",
              "AbortError",
            );
          }
        },
        close() {
          lifetime?.controller.signal.removeEventListener("abort", abort);
          abort();
        },
      });
    },
    [],
  );
}
