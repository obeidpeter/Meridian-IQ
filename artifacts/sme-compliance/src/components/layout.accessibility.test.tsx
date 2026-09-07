// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return { ...actual, useGetMe: () => ({ data: undefined }) };
});
vi.mock("@/components/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/components/stale-build-banner", () => ({
  StaleBuildBanner: () => null,
}));

import { Layout } from "./layout";

let client: QueryClient;
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
});

function renderShell() {
  return render(
    <QueryClientProvider client={client}>
      <Layout>
        <h1>Workspace content</h1>
      </Layout>
    </QueryClientProvider>,
  );
}

test("the mobile brand and navigation controls belong to a banner", () => {
  renderShell();
  const menu = screen.getByRole("button", { name: "Open navigation" });
  const header = menu.closest("header");
  expect(header).not.toBeNull();
  expect(within(header!).getByText("Valo")).toBeTruthy();
  // CSS selects one responsive header; neither belongs inside the main content.
  expect(screen.getAllByRole("banner")).toHaveLength(2);
  expect(header!.closest("main, section, article, aside, nav")).toBeNull();
  expect(screen.getByRole("navigation", { name: "Workspace" })).toBeTruthy();
});

test("mobile workspace context is named without changing the content landmark", () => {
  renderShell();
  const context = screen.getByRole("region", { name: "Current workspace" });
  const labels = context.querySelectorAll("p");
  expect(labels).toHaveLength(2);
  for (const label of labels) expect(label.textContent?.trim()).toBeTruthy();
  const main = screen.getByRole("main");
  expect(
    within(main).getByRole("heading", { name: "Workspace content" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: "Skip to content" }).getAttribute("href"),
  ).toBe("#" + main.id);
});
