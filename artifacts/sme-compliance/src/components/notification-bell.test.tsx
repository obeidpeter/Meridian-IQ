// @vitest-environment jsdom
// The notification bell's contract: the feed drives a real UNREAD badge
// (contract 0.41.0 read state), so it fetches on mount; rows render on
// success only — title, channel chip, relative time, unread rows visually
// distinct — "Mark all read" stamps everything up to the newest visible item
// and refreshes the feed from the returned payload, and the popover
// dismisses on Escape, outside pointer-down (both via the Radix primitive)
// and on navigation.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { NotificationFeed } from "@workspace/api-client-react";
import { badgeText, markReadTimestamp } from "./notification-bell";

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
  },
  markRead: {
    isPending: false,
    // Arguments of the last mutate() call — the mark-all-read contract.
    lastVariables: undefined as
      | { data: { upToCreatedAt: string } }
      | undefined,
  },
  reset() {
    this.feed.data = undefined;
    this.feed.isLoading = false;
    this.feed.isError = false;
    this.markRead.isPending = false;
    this.markRead.lastVariables = undefined;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useListNotifications: () => ({
      data: harness.feed.data,
      isLoading: harness.feed.isLoading,
      isError: harness.feed.isError,
    }),
    useMarkNotificationsRead: () => ({
      isPending: harness.markRead.isPending,
      mutate: (variables: { data: { upToCreatedAt: string } }) => {
        harness.markRead.lastVariables = variables;
      },
    }),
  };
});

// Import AFTER the mock so the component binds the stand-in.
import { NotificationBell } from "./notification-bell";

// The component reaches for useQueryClient (to seed the refreshed feed), so
// every render needs a provider.
const renderBell = (ui: ReactElement = <NotificationBell />) =>
  render(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const bell = () => screen.getByTestId("button-notifications");

// Radix attaches its outside-pointer-down listener on a 0ms timeout after
// open (so the opening click can't self-dismiss) — flush it before firing.
const flushTimers = () => act(() => new Promise((r) => setTimeout(r, 0)));

const item = (
  over: Partial<NotificationFeed["items"][number]> = {},
): NotificationFeed["items"][number] => ({
  id: "n1",
  channel: "email",
  templateKey: "deadline_reminder",
  title: "Submission window closes tomorrow",
  status: "sent",
  read: true,
  createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("badgeText", () => {
  test("nothing unread hides the badge entirely — zero would read as noise", () => {
    expect(badgeText(0)).toBeNull();
    expect(badgeText(-1)).toBeNull();
  });

  test("counts below the page size render as-is; a full page caps with a plus", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(19)).toBe("19");
    expect(badgeText(20)).toBe("20+");
    expect(badgeText(80)).toBe("20+");
  });
});

describe("markReadTimestamp", () => {
  test("hands mark-read the newest item's createdAt (the feed is newest-first)", () => {
    const newest = item({ id: "newest", createdAt: "2026-07-20T10:00:00Z" });
    const older = item({ id: "older", createdAt: "2026-07-19T10:00:00Z" });
    expect(
      markReadTimestamp({ items: [newest, older], unreadCount: 2 }),
    ).toBe("2026-07-20T10:00:00Z");
  });

  test("an empty or absent feed has nothing to mark", () => {
    expect(markReadTimestamp({ items: [], unreadCount: 0 })).toBeNull();
    expect(markReadTimestamp(undefined)).toBeNull();
  });
});

describe("NotificationBell", () => {
  test("shows the unread badge from unreadCount without opening; popover stays closed", () => {
    harness.feed.data = {
      items: [item({ read: false })],
      unreadCount: 3,
    };
    renderBell();
    expect(screen.queryByTestId("popover-notifications")).toBeNull();
    expect(
      screen.getByTestId("badge-notification-count").textContent,
    ).toBe("3");
    expect(bell().getAttribute("aria-label")).toBe(
      "Notifications — 3 unread",
    );

    fireEvent.click(bell());
    expect(screen.getByTestId("popover-notifications")).toBeTruthy();
    expect(bell().getAttribute("aria-expanded")).toBe("true");
  });

  test("nothing unread: no badge, and the trigger label stays plain", () => {
    harness.feed.data = { items: [item()], unreadCount: 0 };
    renderBell();
    expect(screen.queryByTestId("badge-notification-count")).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  test("renders each row with title, channel chip and relative time; unread rows are marked", () => {
    harness.feed.data = {
      items: [
        item({
          id: "n1",
          channel: "whatsapp",
          templateKey: "client_statement_ready",
          title: "Your June statement is ready",
          read: false,
          createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
        item({
          id: "n2",
          channel: "email",
          title: "Submission window closes tomorrow",
          read: true,
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        }),
      ],
      unreadCount: 1,
    };
    renderBell();
    fireEvent.click(bell());

    const first = screen.getByTestId("row-notification-n1");
    expect(first.textContent).toContain("Your June statement is ready");
    expect(first.textContent).toContain("WhatsApp");
    expect(first.textContent).toContain("5m ago");
    // Unread rows carry a screen-reader cue alongside the visual accent.
    expect(first.textContent).toContain("Unread");
    const second = screen.getByTestId("row-notification-n2");
    expect(second.textContent).toContain("Email");
    expect(second.textContent).toContain("3h ago");
    expect(second.textContent).not.toContain("Unread");
  });

  test("mark all read sends the newest item's createdAt", () => {
    const newestAt = new Date(Date.now() - 60_000).toISOString();
    harness.feed.data = {
      items: [
        item({ id: "new", read: false, createdAt: newestAt }),
        item({
          id: "old",
          read: false,
          createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
        }),
      ],
      unreadCount: 2,
    };
    renderBell();
    fireEvent.click(bell());
    fireEvent.click(screen.getByTestId("button-mark-all-read"));
    expect(harness.markRead.lastVariables).toEqual({
      data: { upToCreatedAt: newestAt },
    });
  });

  test("mark all read is offered only while something is unread", () => {
    harness.feed.data = { items: [item()], unreadCount: 0 };
    renderBell();
    fireEvent.click(bell());
    expect(screen.queryByTestId("button-mark-all-read")).toBeNull();
  });

  test("shows the empty state for a quiet feed", () => {
    harness.feed.data = { items: [], unreadCount: 0 };
    renderBell();
    fireEvent.click(bell());
    expect(
      screen.getByTestId("text-notifications-empty").textContent,
    ).toContain("Nothing yet");
  });

  test("render-on-success: an error shows the friendly line, never rows", () => {
    harness.feed.isError = true;
    renderBell();
    fireEvent.click(bell());
    const popover = screen.getByTestId("popover-notifications");
    expect(popover.textContent).toContain("Couldn't load your notifications");
    expect(screen.queryByTestId("text-notifications-empty")).toBeNull();
  });

  test("light-dismiss: Escape and outside pointer-down close the popover", async () => {
    harness.feed.data = { items: [], unreadCount: 0 };
    renderBell();
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
    renderBell(
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
