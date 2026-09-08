// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderShell() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Layout>
          <h1>Workspace content</h1>
        </Layout>
      </QueryClientProvider>,
    );
  });
}

test("the mobile brand and navigation controls belong to a banner", async () => {
  await renderShell();
  const menu = container.querySelector('[aria-label="Open navigation"]')!;
  const header = menu.closest("header");
  expect(header).not.toBeNull();
  expect(header!.textContent).toContain("Valo");
  // CSS selects one responsive header; neither belongs inside the main content.
  expect(container.querySelectorAll("header")).toHaveLength(2);
  expect(header!.closest("main, section, article, aside, nav")).toBeNull();
  expect(container.querySelectorAll("nav")).toHaveLength(1);
});

test("mobile workspace context is named without changing the content landmark", async () => {
  await renderShell();
  const context = container.querySelector(
    'section[aria-label="Current workspace"]',
  );
  expect(context).not.toBeNull();
  const labels = context!.querySelectorAll("p");
  expect(labels).toHaveLength(2);
  for (const label of labels) expect(label.textContent?.trim()).toBeTruthy();
  expect(container.querySelectorAll("main")).toHaveLength(1);
  const main = container.querySelector("main")!;
  expect(main.querySelector("h1")?.textContent).toBe("Workspace content");
  expect(
    container.querySelector(`a[href="#${main.id}"]`)?.textContent?.trim(),
  ).toBe("Skip to content");
});

test("the whole buyer shell pairs its surface with theme-aware content", async () => {
  await renderShell();
  const shell = container.querySelector(".min-h-screen")!;
  expect(shell.classList.contains("mi-platform")).toBe(true);
  expect(shell.classList.contains("bg-[var(--mi-canvas)]")).toBe(true);
  expect(shell.contains(container.querySelector("main"))).toBe(true);
  const desktopHeader = container.querySelector("header.mi-topbar")!;
  expect(desktopHeader).not.toBeNull();
  expect(container.querySelector("header.mi-mobilebar")).not.toBeNull();
  expect(container.querySelector("nav.mi-sidebar")).not.toBeNull();
  expect(container.querySelectorAll("nav a.mi-nav__link").length).toBe(6);
  expect(desktopHeader.className).not.toMatch(/white|slate|cyan/);
});
