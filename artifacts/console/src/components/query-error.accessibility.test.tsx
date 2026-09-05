// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryError } from "./query-error";

afterEach(cleanup);

test("error message uses a dark-surface ink while preserving the alert and retry", () => {
  const retry = vi.fn();
  render(<QueryError thing="the filing desk" onRetry={retry} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  const message = screen.getByTestId("text-error");
  expect(message.textContent).toBe("Unable to load the filing desk.");
  expect(message.className).toContain("text-destructive");
  expect(message.className).toContain("dark:text-red-300");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
});

test("optional endpoint detail remains distinct from the high-contrast error message", () => {
  render(
    <QueryError thing="firm branding" detail="HTTP 503" onRetry={() => {}} />,
  );
  expect(screen.getByTestId("text-error-detail").textContent).toBe("HTTP 503");
  expect(screen.getByTestId("text-error").textContent).toBe(
    "Unable to load firm branding.",
  );
});
