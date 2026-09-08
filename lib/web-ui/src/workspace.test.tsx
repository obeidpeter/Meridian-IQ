// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { StrictMode, useState } from "react";
import { CommandMenu, SegmentedControl, type CommandItem } from "./workspace";

// RTL's auto-cleanup needs framework globals, which stay off here.
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const items: CommandItem[] = [
  { id: "cmd-one", label: "One", onSelect: () => {} },
  { id: "cmd-two", label: "Two", onSelect: () => {} },
];

function ControlledMenu({
  commands = items,
  mounted = true,
  showDesktopTrigger = true,
}: {
  commands?: CommandItem[];
  mounted?: boolean;
  showDesktopTrigger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {showDesktopTrigger && (
        <button onClick={() => setOpen(true)}>Search desktop</button>
      )}
      <button onClick={() => setOpen(true)}>Search mobile</button>
      <button onClick={() => setOpen(false)}>External close</button>
      <main tabIndex={-1}>Navigation destination</main>
      {mounted && (
        <CommandMenu items={commands} open={open} onOpenChange={setOpen} />
      )}
    </>
  );
}

function openControlledMenu(name = "Search desktop") {
  const trigger = screen.getByRole("button", { name });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

function focusMenuInput() {
  act(() => vi.runOnlyPendingTimers());
  const input = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  return input;
}

test("opening focuses the dialog before timers so immediate Escape can close it", () => {
  vi.useFakeTimers();
  render(<ControlledMenu />);
  const trigger = openControlledMenu();
  const input = screen.getByRole("searchbox");
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("controlled Search click and Escape restore the initiating button in StrictMode", () => {
  vi.useFakeTimers();
  render(
    <StrictMode>
      <ControlledMenu />
    </StrictMode>,
  );
  const trigger = openControlledMenu();
  const input = focusMenuInput();

  fireEvent.keyDown(input, { key: "Escape" });

  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  act(() => vi.runOnlyPendingTimers());
  expect(document.activeElement).toBe(trigger);
});

test("each controlled opening captures its own trigger instead of a stale target", () => {
  vi.useFakeTimers();
  render(<ControlledMenu />);
  for (const name of ["Search desktop", "Search mobile", "Search desktop"]) {
    const trigger = openControlledMenu(name);
    fireEvent.keyDown(focusMenuInput(), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
  }
});

test.each(["ctrlKey", "metaKey"])(
  "%s+K opening and closing restore the focused trigger",
  (modifier) => {
    vi.useFakeTimers();
    render(<ControlledMenu />);
    const trigger = screen.getByRole("button", { name: "Search mobile" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "k", [modifier]: true });
    fireEvent.keyDown(focusMenuInput(), { key: "k", [modifier]: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

test("an uncontrolled render-prop trigger retains focus restoration", () => {
  vi.useFakeTimers();
  render(
    <CommandMenu
      items={items}
      trigger={(show) => <button onClick={show}>Search desktop</button>}
    />,
  );
  const trigger = openControlledMenu();
  fireEvent.keyDown(focusMenuInput(), { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
});

test.each(["close", "unmount"])(
  "immediate external %s restores focus and scroll lock without deferred refocus",
  (action) => {
    vi.useFakeTimers();
    const view = render(<ControlledMenu />);
    const previousOverflow = document.body.style.overflow;
    const trigger = openControlledMenu();
    const input = screen.getByRole("searchbox");
    const focus = vi.spyOn(input, "focus");
    expect(document.activeElement).toBe(input);
    expect(document.body.style.overflow).toBe("hidden");

    if (action === "close") {
      fireEvent.click(screen.getByRole("button", { name: "External close" }));
    } else {
      view.rerender(<ControlledMenu mounted={false} />);
    }
    act(() => vi.runOnlyPendingTimers());
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe(previousOverflow);
  },
);

test("external close restores focus when the menu owned it", () => {
  vi.useFakeTimers();
  render(<ControlledMenu />);
  const trigger = openControlledMenu();
  focusMenuInput();
  fireEvent.click(screen.getByRole("button", { name: "External close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("external close preserves focus already assigned to navigation", () => {
  vi.useFakeTimers();
  render(<ControlledMenu />);
  const trigger = openControlledMenu();
  focusMenuInput();
  const restore = vi.spyOn(trigger, "focus");
  const destination = screen.getByRole("main");
  destination.focus();
  fireEvent.click(screen.getByRole("button", { name: "External close" }));
  act(() => vi.runOnlyPendingTimers());
  expect(document.activeElement).toBe(destination);
  expect(restore).not.toHaveBeenCalled();
});

test("opening never schedules a delayed focus that can steal it from navigation", () => {
  vi.useFakeTimers();
  render(<ControlledMenu />);
  openControlledMenu();
  const input = screen.getByRole("searchbox");
  const focus = vi.spyOn(input, "focus");
  const destination = screen.getByRole("main");
  destination.focus();
  act(() => vi.runOnlyPendingTimers());
  expect(document.activeElement).toBe(destination);
  expect(focus).not.toHaveBeenCalled();
});

test("choosing a command leaves focus to its navigation without restoring the opener", () => {
  vi.useFakeTimers();
  render(
    <ControlledMenu
      commands={[
        {
          id: "navigate",
          label: "Open destination",
          onSelect: () =>
            window.setTimeout(() => screen.getByRole("main").focus(), 0),
        },
      ]}
    />,
  );
  const trigger = openControlledMenu();
  const input = focusMenuInput();
  const restore = vi.spyOn(trigger, "focus");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(restore).not.toHaveBeenCalled();
  act(() => vi.runOnlyPendingTimers());
  expect(document.activeElement).toBe(screen.getByRole("main"));
  expect(restore).not.toHaveBeenCalled();
});

test("closing never focuses a removed opener", () => {
  vi.useFakeTimers();
  const view = render(<ControlledMenu />);
  const trigger = openControlledMenu();
  const input = focusMenuInput();
  const restore = vi.spyOn(trigger, "focus");
  view.rerender(<ControlledMenu showDesktopTrigger={false} />);
  expect(trigger.isConnected).toBe(false);
  fireEvent.keyDown(input, { key: "Escape" });
  act(() => vi.runOnlyPendingTimers());
  expect(restore).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(document.body);
});

test.each(["menu", "shell"])(
  "unmounting the %s restores only a still-connected opener",
  (scope) => {
    vi.useFakeTimers();
    const view = render(<ControlledMenu />);
    const trigger = openControlledMenu();
    focusMenuInput();
    const restore = vi.spyOn(trigger, "focus");
    if (scope === "menu") view.rerender(<ControlledMenu mounted={false} />);
    else view.unmount();
    act(() => vi.runOnlyPendingTimers());
    expect(document.activeElement).toBe(
      scope === "menu" ? trigger : document.body,
    );
    expect(restore).toHaveBeenCalledTimes(scope === "menu" ? 1 : 0);
  },
);

test("Escape closes the command menu from any focused child, not just the input", () => {
  const onOpenChange = vi.fn();
  render(<CommandMenu items={items} open onOpenChange={onOpenChange} />);
  const close = screen.getByRole("button", { name: "Close command menu" });
  close.focus();
  fireEvent.keyDown(close, { key: "Escape" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

test("Tab wraps focus inside the dialog instead of escaping into the page", () => {
  render(<CommandMenu items={items} open onOpenChange={() => {}} />);
  const input = screen.getByRole("searchbox");
  const options = screen.getAllByRole("option");
  const last = options[options.length - 1];

  last.focus();
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(input);

  input.focus();
  fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
});

test("SegmentedControl is a toggle-button group, not fake tabs", () => {
  render(
    <SegmentedControl
      items={[
        { value: "a", label: "Alpha" },
        { value: "b", label: "Beta" },
      ]}
      value="a"
      onChange={() => {}}
      label="View"
    />,
  );
  expect(screen.queryByRole("tab")).toBeNull();
  const group = screen.getByRole("group", { name: "View" });
  const [alpha, beta] = Array.from(group.querySelectorAll("button"));
  expect(alpha.getAttribute("aria-pressed")).toBe("true");
  expect(beta.getAttribute("aria-pressed")).toBe("false");
});

test("remote command search aborts a stale request before showing new results", async () => {
  vi.useFakeTimers();
  const pending = new Map<
    string,
    { signal: AbortSignal; resolve: (items: CommandItem[]) => void }
  >();
  const remoteSearch = vi.fn(
    (query: string, signal: AbortSignal) =>
      new Promise<CommandItem[]>((resolve) => {
        pending.set(query, { signal, resolve });
      }),
  );
  render(
    <CommandMenu
      items={items}
      open
      onOpenChange={() => {}}
      remoteSearch={remoteSearch}
    />,
  );
  const input = screen.getByRole("searchbox");
  fireEvent.change(input, { target: { value: "first" } });
  await act(async () => vi.advanceTimersByTime(220));
  expect(remoteSearch).toHaveBeenCalledTimes(1);

  fireEvent.change(input, { target: { value: "second" } });
  expect(pending.get("first")?.signal.aborted).toBe(true);
  await act(async () => vi.advanceTimersByTime(220));
  pending
    .get("first")
    ?.resolve([{ id: "stale", label: "Stale result", onSelect: () => {} }]);
  pending
    .get("second")
    ?.resolve([{ id: "fresh", label: "Fresh result", onSelect: () => {} }]);
  await act(async () => Promise.resolve());

  expect(screen.getByRole("option", { name: /Fresh result/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Stale result/ })).toBeNull();
  vi.useRealTimers();
});
