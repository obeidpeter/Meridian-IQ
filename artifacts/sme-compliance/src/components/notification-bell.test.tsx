// @vitest-environment jsdom
// The notification bell's contract: nothing fetched (and nothing rendered)
// until the user opens it, rows render on success only — title, channel
// chip, relative time — and the popover dismisses on Escape, outside
// pointer-down (both via the Radix primitive now) and on navigation.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { NotificationFeed } from "@workspace/api-client-react";

// Radix's popper positioning needs a ResizeObserver; jsdom has none.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverStub;

const harness = vi.hoisted(() => ({
  feed: {
    data: undefined as NotificationFeed | undefined,
    isLoading: false,
    isError: false,
    // The `enabled` option the component handed the hook on its last render —
    // the "a page view costs nothing" invariant.
    lastEnabled: undefined as boolean | undefined,
  },
  reset() {
    this.feed.data = undefined;
    this.feed.isLoading = false;
    this.feed.isError = false;
    this.feed.lastEnabled = undefined;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListNotifications: (
      _params: unknown,
      options?: { query?: { enabled?: boolean } },
    ) => {
      harness.feed.lastEnabled = options?.query?.enabled;
      return {
        data: harness.feed.data,
        isLoading: harness.feed.isLoading,
        isError: harness.feed.isError,
      };
    },
  };
});

// Import AFTER the mock so the component binds the stand-in.
import { NotificationBell } from "./notification-bell";

const bell = () => screen.getByTestId("button-notifications");

// Radix attaches its outside-pointer-down listener on a 0ms timeout after
// open (so the opening click can't self-dismiss) — flush it before firing.
const flushTimers = () => act(() => new Promise((r) => setTimeout(r, 0)));

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("NotificationBell", () => {
  test("stays closed and keeps the fetch disabled until opened", () => {
    render(<NotificationBell />);
    expect(screen.queryByTestId("popover-notifications")).toBeNull();
    expect(harness.feed.lastEnabled).toBe(false);

    fireEvent.click(bell());
    expect(screen.getByTestId("popover-notifications")).toBeTruthy();
    expect(harness.feed.lastEnabled).toBe(true);
    expect(bell().getAttribute("aria-expanded")).toBe("true");
  });

  test("renders each row with title, channel chip and relative time", () => {
    harness.feed.data = {
      items: [
        {
          id: "n1",
          channel: "whatsapp",
          templateKey: "client_statement_ready",
          title: "Your June statement is ready",
          status: "sent",
          createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
        {
          id: "n2",
          channel: "email",
          templateKey: "deadline_reminder",
          title: "Submission window closes tomorrow",
          status: "sent",
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        },
      ],
    };
    render(<NotificationBell />);
    fireEvent.click(bell());

    const first = screen.getByTestId("row-notification-n1");
    expect(first.textContent).toContain("Your June statement is ready");
    expect(first.textContent).toContain("WhatsApp");
    expect(first.textContent).toContain("5m ago");
    const second = screen.getByTestId("row-notification-n2");
    expect(second.textContent).toContain("Email");
    expect(second.textContent).toContain("3h ago");
  });

  test("shows the empty state for a quiet feed", () => {
    harness.feed.data = { items: [] };
    render(<NotificationBell />);
    fireEvent.click(bell());
    expect(
      screen.getByTestId("text-notifications-empty").textContent,
    ).toContain("Nothing yet");
  });

  test("render-on-success: an error shows the friendly line, never rows", () => {
    harness.feed.isError = true;
    render(<NotificationBell />);
    fireEvent.click(bell());
    const popover = screen.getByTestId("popover-notifications");
    expect(popover.textContent).toContain("Couldn't load your notifications");
    expect(screen.queryByTestId("text-notifications-empty")).toBeNull();
  });

  test("light-dismiss: Escape and outside pointer-down close the popover", async () => {
    harness.feed.data = { items: [] };
    render(<NotificationBell />);
    fireEvent.click(bell());
    expect(screen.getByTestId("popover-notifications")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("popover-notifications")).toBeNull();

    fireEvent.click(bell());
    expect(screen.getByTestId("popover-notifications")).toBeTruthy();
    await flushTimers();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("popover-notifications")).toBeNull();
  });

  test("a wouter navigation closes the popover", async () => {
    const { hook, navigate } = memoryLocation({ path: "/" });
    render(
      <Router hook={hook}>
        <NotificationBell />
      </Router>,
    );
    fireEvent.click(bell());
    expect(screen.getByTestId("popover-notifications")).toBeTruthy();

    act(() => navigate("/invoices"));
    expect(screen.queryByTestId("popover-notifications")).toBeNull();
  });
});
