// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CommandMenu, SegmentedControl, type CommandItem } from "./workspace";

// RTL's auto-cleanup needs framework globals, which stay off here.
afterEach(cleanup);

const items: CommandItem[] = [
  { id: "cmd-one", label: "One", onSelect: () => {} },
  { id: "cmd-two", label: "Two", onSelect: () => {} },
];

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
