// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TodayWorkspace } from "./today";

afterEach(cleanup);
test("each setup step exposes completion in its accessible name", () => {
  render(
    <TodayWorkspace
      eyebrow="Business"
      title="Today"
      description="Priorities"
      generatedAt="2026-09-05T12:00:00Z"
      summary={{
        total: 0,
        urgent: 0,
        dueSoon: 0,
        blocked: 0,
        completedSetupSteps: 1,
        totalSetupSteps: 2,
      }}
      items={[]}
      setup={[
        {
          id: "one",
          label: "Create invoice",
          description: "First invoice",
          complete: true,
          href: "/invoices",
        },
        {
          id: "two",
          label: "Review consent",
          description: "Sharing choices",
          complete: false,
          href: "/consent",
        },
      ]}
      onOpen={() => {}}
    />,
  );
  expect(
    screen.getByRole("button", {
      name: "Create invoice Completed First invoice",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Review consent Not completed Sharing choices",
    }),
  ).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "50",
  );
});
