// @vitest-environment jsdom
// The notification bell's contract, mirrored from the SME app's suite: the
// feed drives a real UNREAD badge (contract 0.41.0 read state), so it
// fetches on mount; rows render on success only — title, channel chip,
// relative time, unread rows visually distinct — "Mark all read" POSTs the
// newest visible item's createdAt and refreshes the feed from the returned
// payload, and the hand-rolled popover dismisses on Escape, outside
// pointer-down and navigation. Network = stubbed global fetch; the real
// generated hooks and react-query run.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import type { NotificationFeed } from "@workspace/api-client-react";
import { badgeText, markReadTimestamp } from "@/lib/notifications";
import { NotificationBell } from "./notification-bell";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

const harness: {
  feed: NotificationFeed;
  feedStatus: number;
  refreshed: NotificationFeed | null;
  calls: Array<{ url: string; method: string; body?: unknown }>;
} = {
  feed: { items: [], unreadCount: 0 },
  feedStatus: 200,
  refreshed: null,
  calls: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

async function renderBell(ui: ReactElement = <NotificationBell />) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
    );
  });
  await flush();
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`);

const bell = () => byTestId("button-notifications")!;

const click = (el: Element | null) =>
  act(async () => {
    (el as HTMLElement).click();
  });

beforeEach(() => {
  harness.feed = { items: [], unreadCount: 0 };
  harness.feedStatus = 200;
  harness.refreshed = null;
  harness.calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      harness.calls.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.startsWith("/api/notifications/mark-read") && method === "POST") {
        return jsonResponse(harness.refreshed ?? harness.feed);
      }
      if (url.startsWith("/api/notifications")) {
        return harness.feedStatus === 200
          ? jsonResponse(harness.feed)
          : jsonResponse({ message: "not found" }, harness.feedStatus);
      }
      return jsonResponse({ message: "not found" }, 404);
    }),
  );
});

afterEach(async () => {
  if (root) {
    const r = root;
    await act(async () => r.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
    expect(markReadTimestamp({ items: [newest, older], unreadCount: 2 })).toBe(
      "2026-07-20T10:00:00Z",
    );
  });

  test("an empty or absent feed has nothing to mark", () => {
    expect(markReadTimestamp({ items: [], unreadCount: 0 })).toBeNull();
    expect(markReadTimestamp(undefined)).toBeNull();
  });
});

describe("NotificationBell", () => {
  test("fetches the feed on mount and requests the bell's page size", async () => {
    await renderBell();
    expect(harness.calls[0]!.url).toBe("/api/notifications?limit=20");
  });

  test("shows the unread badge from unreadCount without opening; popover opens on click", async () => {
    harness.feed = { items: [item({ read: false })], unreadCount: 3 };
    await renderBell();

    expect(byTestId("popover-notifications")).toBeNull();
    expect(byTestId("badge-notification-count")!.textContent).toBe("3");
    expect(bell().getAttribute("aria-label")).toBe("Notifications — 3 unread");

    await click(bell());
    expect(byTestId("popover-notifications")).not.toBeNull();
    expect(bell().getAttribute("aria-expanded")).toBe("true");
  });

  test("nothing unread: no badge, and the trigger label stays plain", async () => {
    harness.feed = { items: [item()], unreadCount: 0 };
    await renderBell();
    expect(byTestId("badge-notification-count")).toBeNull();
    expect(bell().getAttribute("aria-label")).toBe("Notifications");
  });

  test("renders each row with title, channel chip and relative time; unread rows are marked", async () => {
    harness.feed = {
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
    await renderBell();
    await click(bell());

    const first = byTestId("row-notification-n1")!;
    expect(first.textContent).toContain("Your June statement is ready");
    expect(first.textContent).toContain("WhatsApp");
    expect(first.textContent).toContain("5m ago");
    // Unread rows carry a screen-reader cue alongside the visual accent.
    expect(first.textContent).toContain("Unread");
    const second = byTestId("row-notification-n2")!;
    expect(second.textContent).toContain("Email");
    expect(second.textContent).toContain("3h ago");
    expect(second.textContent).not.toContain("Unread");
  });

  test("mark all read POSTs the newest item's createdAt and settles the badge from the returned feed", async () => {
    const newestAt = new Date(Date.now() - 60_000).toISOString();
    harness.feed = {
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
    harness.refreshed = {
      items: harness.feed.items.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    };
    await renderBell();
    await click(bell());
    await click(byTestId("button-mark-all-read"));
    await flush();

    const post = harness.calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toBe("/api/notifications/mark-read");
    expect(post!.body).toEqual({ upToCreatedAt: newestAt });

    // The returned payload seeds the cache: badge gone, rows settle read,
    // and no second GET is needed.
    expect(byTestId("badge-notification-count")).toBeNull();
    expect(byTestId("button-mark-all-read")).toBeNull();
    expect(
      harness.calls.filter((c) => c.method === "GET").length,
    ).toBe(1);
  });

  test("mark all read is offered only while something is unread", async () => {
    harness.feed = { items: [item()], unreadCount: 0 };
    await renderBell();
    await click(bell());
    expect(byTestId("popover-notifications")).not.toBeNull();
    expect(byTestId("button-mark-all-read")).toBeNull();
  });

  test("shows the empty state for a quiet feed", async () => {
    harness.feed = { items: [], unreadCount: 0 };
    await renderBell();
    await click(bell());
    expect(byTestId("text-notifications-empty")!.textContent).toContain(
      "Nothing yet — alerts we send you will show up here.",
    );
  });

  test("render-on-success: an error shows the friendly line, never rows", async () => {
    harness.feedStatus = 500;
    await renderBell();
    await click(bell());
    const popover = byTestId("popover-notifications")!;
    expect(popover.textContent).toContain("Couldn't load your notifications");
    expect(byTestId("text-notifications-empty")).toBeNull();
  });

  test("light-dismiss: Escape and outside pointer-down close the popover", async () => {
    await renderBell();
    await click(bell());
    expect(byTestId("popover-notifications")).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(byTestId("popover-notifications")).toBeNull();

    await click(bell());
    expect(byTestId("popover-notifications")).not.toBeNull();
    await act(async () => {
      document.body.dispatchEvent(
        new Event("pointerdown", { bubbles: true }),
      );
    });
    expect(byTestId("popover-notifications")).toBeNull();
  });

  test("a wouter navigation closes the popover", async () => {
    const { hook, navigate } = memoryLocation({ path: "/" });
    await renderBell(
      <Router hook={hook}>
        <NotificationBell />
      </Router>,
    );
    await click(bell());
    expect(byTestId("popover-notifications")).not.toBeNull();

    await act(async () => navigate("/suppliers"));
    expect(byTestId("popover-notifications")).toBeNull();
  });
});
