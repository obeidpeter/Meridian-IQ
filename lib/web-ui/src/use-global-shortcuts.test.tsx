// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { isTypingTarget, useGlobalShortcuts } from "./use-global-shortcuts";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function press(
  key: string,
  target: EventTarget = document.body,
  init: KeyboardEventInit = {},
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("useGlobalShortcuts", () => {
  test("runs the matching binding and prevents the default", () => {
    const run = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: "n", run }]));
    const event = press("n");
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  test("matches the produced character, so Shift+/ arrives as ?", () => {
    const run = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: "?", run }]));
    press("?", document.body, { shiftKey: true });
    expect(run).toHaveBeenCalledTimes(1);
    // Shift+n produces "N", which no binding claims.
    press("N", document.body, { shiftKey: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("ignores chords, repeats and already-handled events", () => {
    const run = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: "n", run }]));
    press("n", document.body, { ctrlKey: true });
    press("n", document.body, { metaKey: true });
    press("n", document.body, { altKey: true });
    press("n", document.body, { repeat: true });
    const handled = new KeyboardEvent("keydown", {
      key: "n",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(run).not.toHaveBeenCalled();
  });

  test("stays quiet while the user is typing or inside a dialog", () => {
    const run = vi.fn();
    renderHook(() => useGlobalShortcuts([{ key: "n", run }]));
    document.body.innerHTML =
      '<input id="field" /><div role="dialog"><button id="confirm">Yes</button></div>';
    press("n", document.getElementById("field")!);
    press("n", document.getElementById("confirm")!);
    expect(run).not.toHaveBeenCalled();
    // Back on the page body the binding fires again.
    press("n");
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("re-renders swap bindings without re-subscribing", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ run }: { run: () => void }) => useGlobalShortcuts([{ key: "n", run }]),
      { initialProps: { run: first } },
    );
    rerender({ run: second });
    press("n");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("isTypingTarget", () => {
  test("claims text controls, dialogs and menus; leaves the page free", () => {
    document.body.innerHTML =
      '<main id="page"><input id="i" /><textarea id="t"></textarea>' +
      '<select id="s"></select><div contenteditable="true" id="c"></div>' +
      '<div role="menu"><button id="m">Item</button></div></main>';
    for (const id of ["i", "t", "s", "c", "m"]) {
      expect(isTypingTarget(document.getElementById(id))).toBe(true);
    }
    expect(isTypingTarget(document.getElementById("page"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
