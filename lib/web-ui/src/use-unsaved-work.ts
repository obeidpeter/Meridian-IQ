import { useContext, useLayoutEffect, useRef } from "react";
import { NavigationContext } from "./navigation-context";
import type { UnsavedWorkHandler } from "./unsaved-work-controller";

/** Register while mounted, not only while dirty: successful saves must be able
 * to clear dirty state without invalidating their pending navigation request. */
export function useUnsavedWork({
  dirty,
  save,
  discard,
  disabledReason,
}: {
  dirty: boolean;
  save: () => Promise<boolean>;
  discard: () => boolean;
  disabledReason?: string | null;
}) {
  const navigation = useContext(NavigationContext);
  const current = useRef({ dirty, save, discard, disabledReason });
  useLayoutEffect(() => {
    current.current = { dirty, save, discard, disabledReason };
  });
  useLayoutEffect(() => {
    const handler: UnsavedWorkHandler = {
      isDirty: () => current.current.dirty,
      save: async () => {
        const saved = await current.current.save();
        if (saved) current.current.dirty = false;
        return saved;
      },
      discard: () => {
        const discarded = current.current.discard();
        if (discarded) current.current.dirty = false;
        return discarded;
      },
      saveDisabledReason: () => current.current.disabledReason,
    };
    if (navigation) return navigation.work.register(handler);
    // Standalone form consumers retain the existing tab-close safeguard.
    const warn = (event: BeforeUnloadEvent) => {
      if (!handler.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [navigation, disabledReason]);
}
