// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { TodayWorkspace, type TodaySetupStepView } from "./today";

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

function step(id: string, label: string, complete = false): TodaySetupStepView {
  return {
    id,
    label,
    description: `Details for ${label}`,
    complete,
    href: `/${id}`,
  };
}

const defaults: ComponentProps<typeof TodayWorkspace> = {
  eyebrow: "Business",
  title: "Today",
  description: "Priorities",
  generatedAt: "2026-09-05T12:00:00Z",
  summary: {
    total: 0,
    urgent: 0,
    dueSoon: 0,
    blocked: 0,
    completedSetupSteps: 0,
    totalSetupSteps: 0,
  },
  items: [],
  setup: [],
  onOpen: () => {},
};

test("client journey recommends one access action and names completed and waiting steps", () => {
  render(
    <TodayWorkspace
      {...defaults}
      setup={[
        step("business_identity", "Business details", true),
        step("first_invoice", "Save a draft"),
        step("invoice_validation", "Validate the invoice"),
        step("first_customer", "Add a customer"),
        step("two_factor", "Secure your account"),
      ]}
    />,
  );
  const journey = screen.getByRole("region", { name: "First-invoice journey" });
  expect(
    within(journey).getAllByRole("button", { name: /^Continue:/ }),
  ).toHaveLength(1);
  expect(
    screen.getByRole("button", { name: "Continue: Secure your account" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /Business details Completed/ }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: /Save a draft Waiting.*Waiting for: Add a customer/,
    }),
  ).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe(
    "1 of 5 complete",
  );
  expect(within(journey).getByText("2 steps need attention.")).toBeTruthy();
});

test.each([
  [
    "firm admin",
    [
      step("first_connection", "Connect accounting"),
      step("first_invoice", "Import invoice"),
      step("first_client", "Add client"),
    ],
    "Add client",
    true,
  ],
  [
    "firm staff",
    [
      step("first_invoice", "Import invoice"),
      step("first_client", "Add client", true),
    ],
    "Import invoice",
    false,
  ],
  [
    "client with reconciliation off",
    [step("first_invoice", "Save draft")],
    "Save draft",
    false,
  ],
] as const)(
  "%s sees only server-provided actions",
  (_role, setup, next, hasConnection) => {
    render(<TodayWorkspace {...defaults} setup={[...setup]} />);
    expect(
      screen.getByRole("button", { name: `Continue: ${next}` }),
    ).toBeTruthy();
    expect(
      Boolean(
        screen.queryByRole("button", {
          name: /Connect accounting Not completed/,
        }),
      ),
    ).toBe(hasConnection);
    expect(
      screen.queryByRole("button", { name: /statement|submission|stamping/i }),
    ).toBeNull();
  },
);

test.each([
  [
    "buyer",
    [
      step("review_queue", "Review confirmations", true),
      step("first_confirmation", "Confirm invoice"),
    ],
    "Confirm invoice",
  ],
  ["operator", [step("activation", "Review activation")], "Review activation"],
] as const)(
  "%s keeps its role-specific generic setup",
  (_role, setup, next) => {
    render(<TodayWorkspace {...defaults} setup={[...setup]} />);
    expect(screen.getByRole("region", { name: "Getting ready" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: `Continue: ${next}` }),
    ).toBeTruthy();
    expect(screen.queryByText("First-invoice journey")).toBeNull();
    expect(
      screen.queryByRole("button", { name: /customer|business details/i }),
    ).toBeNull();
  },
);

test("empty setup is not fictitious completion and leaves a clear queue", () => {
  render(<TodayWorkspace {...defaults} />);
  expect(screen.getByText("No setup steps apply to this role.")).toBeTruthy();
  expect(screen.getByText("Not applicable")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("100%")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Continue:/ })).toBeNull();
  expect(screen.getByText("Your priority queue is clear")).toBeTruthy();
});

test("completion uses records rather than conflicting summary totals and preserves review", () => {
  const onOpen = vi.fn();
  render(
    <TodayWorkspace
      {...defaults}
      onOpen={onOpen}
      setup={[
        step("first_invoice", "Draft saved", true),
        step("invoice_validation", "Validation passed", true),
        step("invoice_evidence", "History recorded", true),
      ]}
    />,
  );
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "100",
  );
  expect(
    screen.getByText("All available setup steps are complete."),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Continue:/ })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /History recorded Completed/ }),
  );
  expect(onOpen).toHaveBeenCalledWith("/invoice_evidence");
  expect(screen.queryByText(/stamped|compliant|live provider/i)).toBeNull();
});

test("navigation never completes a step; a returned record resumes the next step", () => {
  const onOpen = vi.fn();
  const setup = [
    step("first_invoice", "Save draft"),
    step("invoice_validation", "Validate draft"),
  ];
  const { rerender, unmount } = render(
    <TodayWorkspace {...defaults} onOpen={onOpen} setup={setup} />,
  );
  const next = screen.getByRole("button", { name: "Continue: Save draft" });
  next.focus();
  expect(document.activeElement).toBe(next);
  expect(next.getAttribute("type")).toBe("button");
  expect(next.getAttribute("aria-describedby")).toBeTruthy();
  fireEvent.click(next);
  expect(onOpen).toHaveBeenCalledExactlyOnceWith("/first_invoice");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "0",
  );
  rerender(
    <TodayWorkspace
      {...defaults}
      onOpen={onOpen}
      setup={[{ ...setup[0], complete: true }, setup[1]]}
    />,
  );
  expect(
    screen.getByRole("button", { name: "Continue: Validate draft" }),
  ).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "50",
  );
  expect(onOpen).toHaveBeenCalledTimes(1);
  unmount();
  render(<TodayWorkspace {...defaults} setup={setup} />);
  expect(
    screen.getByRole("button", { name: "Continue: Save draft" }),
  ).toBeTruthy();
});

test("record restrictions are named and skipped without blocking recorded evidence", () => {
  render(
    <TodayWorkspace
      {...defaults}
      setup={[
        step("first_invoice", "Draft saved", true),
        step("invoice_validation", "Validate draft", true),
        {
          ...step("invoice_submission", "Submit sandbox invoice"),
          blockedReason: "A different approver is required.",
        },
        step("invoice_evidence", "Open recorded history"),
      ]}
    />,
  );
  const blocked = screen.getByRole("button", {
    name: /Submit sandbox invoice Blocked.*A different approver is required/,
  });
  expect(blocked.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByRole("button", { name: "Continue: Open recorded history" }),
  ).toBeTruthy();
  expect(screen.getByText("1 step needs attention.")).toBeTruthy();
});

test("all-blocked is not complete and never navigates a blocked destination", () => {
  const onOpen = vi.fn();
  render(
    <TodayWorkspace
      {...defaults}
      onOpen={onOpen}
      setup={[
        {
          ...step("first_invoice", "Create invoice"),
          blockedReason: "Workspace access needs attention.",
        },
      ]}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Create invoice Blocked/ }),
  );
  expect(onOpen).not.toHaveBeenCalled();
  expect(
    screen.getByText(
      "The remaining steps need attention before you can continue.",
    ),
  ).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Continue:/ })).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
    "0",
  );
});

test("loading and errors with cached setup do not claim confirmed completion", () => {
  const onRetrySetup = vi.fn();
  const setup = [step("first_invoice", "Draft saved", true)];
  const { rerender } = render(
    <TodayWorkspace {...defaults} setup={setup} setupLoading />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Loading setup records...",
  );
  expect(screen.getByText("Checking")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  rerender(
    <TodayWorkspace
      {...defaults}
      setup={setup}
      setupError="Please try again."
      onRetrySetup={onRetrySetup}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Setup progress is unavailable.",
  );
  const retry = screen.getByRole("button", { name: "Retry setup" });
  retry.focus();
  expect(document.activeElement).toBe(retry);
  fireEvent.click(retry);
  expect(onRetrySetup).toHaveBeenCalledOnce();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("100%")).toBeNull();
  expect(screen.getByText("Your priority queue is clear")).toBeTruthy();
});

test("each workspace has unique accessible heading references", () => {
  render(
    <>
      <TodayWorkspace {...defaults} />
      <TodayWorkspace {...defaults} />
    </>,
  );
  const regions = screen.getAllByRole("region", { name: "Getting ready" });
  expect(regions[0].getAttribute("aria-labelledby")).not.toBe(
    regions[1].getAttribute("aria-labelledby"),
  );
});

test("bounded queue reports shown versus full-population priorities without changing actions", () => {
  const onOpen = vi.fn();
  const onManageWork = vi.fn();
  const item = {
    id: "invoice:one",
    title: "Invoice 001",
    description: "Validation needed",
    priority: "high" as const,
    status: "draft",
    dueAt: null,
    href: "/invoices/one",
    clientName: "Client A",
    source: "invoice",
  };
  render(
    <TodayWorkspace
      {...defaults}
      summary={{ ...defaults.summary, total: 125 }}
      items={[item]}
      onOpen={onOpen}
      onManageWork={onManageWork}
    />,
  );
  expect(screen.getByText(/^Showing 1 of 125 priorities\./)).toBeTruthy();
  expect(screen.getByText("125")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Invoice 001" }));
  expect(onOpen).toHaveBeenCalledWith("/invoices/one", item);
  fireEvent.click(screen.getByRole("button", { name: "Manage work" }));
  expect(onManageWork).toHaveBeenCalledOnce();
});

test("an empty returned slice does not claim a nonempty workspace is clear", () => {
  render(
    <TodayWorkspace
      {...defaults}
      summary={{ ...defaults.summary, total: 125 }}
    />,
  );
  expect(screen.getByText(/^Showing 0 of 125 priorities\./)).toBeTruthy();
  expect(screen.getByText("No priorities in this view")).toBeTruthy();
  expect(screen.queryByText("Your priority queue is clear")).toBeNull();
});
