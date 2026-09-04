// @vitest-environment jsdom
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { lazyRoute, RouteErrorBoundary, RouteLoading } from "./route-recovery";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

test("loading reserves a stable frame and announces progress once", () => {
  render(<RouteLoading />);
  expect(screen.getByRole("status").textContent).toContain("Loading page");
  expect(screen.getByRole("status").closest("section")?.style.minHeight).toBe(
    "20rem",
  );
  expect(
    screen.getByRole("status").closest("section")?.getAttribute("aria-busy"),
  ).toBe("true");
});

test("a rejected chunk retries a fresh lazy import while navigation survives", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("chunk missing"))
    .mockResolvedValue({ default: () => <p>Recovered page</p> });
  const Page = lazyRoute(load);
  render(
    <>
      <nav>
        <a href="/other">Other page</a>
      </nav>
      <Page />
    </>,
  );
  await screen.findByRole("alert");
  expect(screen.getByRole("link", { name: "Other page" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("Recovered page");
  expect(load).toHaveBeenCalledTimes(2);
});

test("render failures expose only a bounded request reference and recover", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  let fail = true;
  function Page() {
    if (fail) throw { requestId: "req-123", message: "private payload" };
    return <p>Ready</p>;
  }
  render(
    <RouteErrorBoundary
      onRetry={() => {
        fail = false;
      }}
    >
      <Page />
    </RouteErrorBoundary>,
  );
  expect(screen.getByText("Request reference: req-123")).toBeTruthy();
  expect(screen.queryByText("private payload")).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Try again" })),
  );
  expect(screen.getByText("Ready")).toBeTruthy();
});
