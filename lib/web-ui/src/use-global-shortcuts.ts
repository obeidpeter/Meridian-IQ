import { useEffect, useRef } from "react";

// Single-key accelerators for frequent users (Shneiderman's "enable shortcuts"
// rule): plain printable keys only — anything involving Ctrl/Meta/Alt belongs
// to the browser or an existing widget (the command menu owns Ctrl+K itself).
// `event.key` already encodes Shift ("?" arrives as "?", Shift+n as "N"), so
// bindings match the produced character, not the physical key.

export interface ShortcutBinding {
  /** The produced character to match against `event.key` (e.g. "n", "/", "?"). */
  key: string;
  run: () => void;
}

/**
 * True when a keystroke belongs to something else: a text control, an open
 * dialog (confirm buttons must not leak "n" into navigation), or a listbox
 * the user is driving with the keyboard.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]',
    ) !== null
  );
}

/** Window-level listener for the given accelerators; skips typing contexts. */
export function useGlobalShortcuts(bindings: ShortcutBinding[]) {
  // The listener reads through a ref so re-renders never re-subscribe.
  const current = useRef(bindings);
  current.current = bindings;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.repeat) return;
      const binding = current.current.find((b) => b.key === event.key);
      if (!binding || isTypingTarget(event.target)) return;
      event.preventDefault();
      binding.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
