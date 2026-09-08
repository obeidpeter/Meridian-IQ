// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ClerkDock, type ClerkDockAnswer } from "./clerk-dock";

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

function props() {
  return {
    contextLabel: "the firm portfolio",
    suggestions: ["What is overdue?", "Which clients need attention?"],
    placeholder: "Ask about your records",
    groundingNote: "Grounded in approved claims and live firm records",
    answer: null as ClerkDockAnswer | null,
    pending: false,
    error: false,
    onAsk: vi.fn(),
    onOpenFull: vi.fn(),
  };
}

async function openDock() {
  fireEvent.click(screen.getByRole("button", { name: "Ask Clerk" }));
  return screen.findByRole("dialog", { name: "Clerk AI" });
}

test.each(["light", "dark"])(
  "%s dock uses primary and paper tokens with 44px controls",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    render(<ClerkDock {...props()} />);
    const trigger = screen.getByTestId("button-clerk-dock");
    expect(trigger.className).toContain("bg-primary");
    expect(trigger.className).toContain("text-primary-foreground");
    expect(trigger.className).toContain("shadow-none");
    expect(trigger.className).toContain("size-11");
    const dialog = await openDock();
    expect(dialog.className).toContain("mi-platform");
    expect(dialog.className).toContain("bg-[var(--mi-paper)]");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      within(dialog).getByText("Working with the firm portfolio"),
    ).toBeTruthy();
    for (const control of within(dialog).getAllByRole("button")) {
      expect(control.className).toMatch(/\b(?:min-h|size)-11\b/);
    }
    const question = within(dialog).getByRole("textbox", { name: "Ask Clerk" });
    expect(question.className).toContain("border-input");
    expect(question.className).toContain("shadow-none");
    expect(
      within(dialog).getByRole("button", { name: "What is overdue?" })
        .className,
    ).toContain("border-[var(--mi-input-line)]");
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  },
);

test("dock preserves suggestions, keyboard submission and pending controls", async () => {
  const input = props();
  const { rerender } = render(<ClerkDock {...input} />);
  const dialog = await openDock();
  fireEvent.click(
    within(dialog).getByRole("button", { name: "What is overdue?" }),
  );
  expect(input.onAsk).toHaveBeenLastCalledWith("What is overdue?");
  const question = within(dialog).getByRole("textbox", { name: "Ask Clerk" });
  expect((question as HTMLTextAreaElement).value).toBe("What is overdue?");
  fireEvent.change(question, { target: { value: "  Summarise my records  " } });
  fireEvent.keyDown(question, { key: "Enter", ctrlKey: true });
  expect(input.onAsk).toHaveBeenLastCalledWith("Summarise my records");
  rerender(<ClerkDock {...input} pending />);
  expect(
    (screen.getByRole("button", { name: /^Asking/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "What is overdue?",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test.each([
  "Full workspace",
  "More detail and proposed actions in the full workspace",
])(
  "%s retains the full-workspace action and closes the dock",
  async (label) => {
    const input = props();
    input.answer = {
      answered: true,
      proposition: "Two invoices need review.",
      facts: [{ key: "count", label: "Invoices", value: "2" }],
      sourceLine: "Approved records, current workspace",
      hasMore: true,
    };
    render(<ClerkDock {...input} />);
    await openDock();
    const source = screen.getByTestId("text-dock-source");
    expect(source.textContent).toContain(input.answer.sourceLine);
    expect(source.className).toContain("text-primary");
    expect(screen.getByTestId("button-dock-more").className).toContain(
      "min-h-11",
    );
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(input.onOpenFull).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  },
);

test("dock retains warning refusals and destructive errors", async () => {
  const input = props();
  input.answer = {
    answered: false,
    refusalReason: "This question is outside the approved scope.",
    facts: [],
  };
  render(<ClerkDock {...input} error errorMessage="Clerk is switched off." />);
  await openDock();
  const refusal = screen.getByText("Clerk declined to answer").parentElement!;
  expect(refusal.className).toContain("text-amber-900");
  expect(refusal.className).toContain("dark:text-amber-200");
  expect(refusal.textContent).toContain(input.answer.refusalReason);
  const alert = screen.getByRole("alert");
  expect(alert.className).toContain("text-destructive");
  expect(alert.getAttribute("data-testid")).toBe("text-dock-error");
  expect(alert.textContent).toBe("Clerk is switched off.");
});
