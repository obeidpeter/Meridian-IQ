// @vitest-environment jsdom
// CORE-03 first-landing capture (D15): a client user whose business has no
// layer-1 decision sees the consent step instead of the workspace; both
// layers must be answered; layer 3 is shown as a separate optional choice; both
// answers land in one idempotent command; the gate lifts by
// invalidating /me, never by local state alone.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithClient } from "../test-utils";

const harness = vi.hoisted(() => ({
  me: {} as Record<string, unknown>,
  calls: [] as unknown[],
  fail: false,
  reset() {
    this.me = {
      userId: "u-1",
      role: "client_user",
      clientPartyId: "cp-1",
      capabilities: ["consent.write"],
      features: [],
      consentCaptured: false,
    };
    this.calls = [];
    this.fail = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({ data: harness.me }),
    useCaptureConsent: () => ({
      isPending: false,
      mutateAsync: async (vars: unknown) => {
        if (harness.fail) throw new Error("ledger unavailable");
        harness.calls.push(vars);
        return {};
      },
    }),
  };
});

import { RequireConsentCapture } from "./require-consent-capture";

beforeEach(() => harness.reset());
afterEach(cleanup);

function renderGate() {
  return renderWithClient(
    <RequireConsentCapture>
      <p data-testid="workspace">workspace</p>
    </RequireConsentCapture>,
  );
}

describe("RequireConsentCapture", () => {
  test("a client user with no layer-1 decision sees the step, not the workspace", () => {
    renderGate();
    expect(screen.getByTestId("consent-capture")).toBeTruthy();
    expect(screen.queryByTestId("workspace")).toBeNull();
    // Layer 3 is present but dormant: no choice is offered.
    const layer3 = screen.getByTestId("consent-capture-layer-3");
    expect(layer3.textContent).toContain("Optional after setup");
    expect(layer3.querySelectorAll("button").length).toBe(0);
  });

  test("firm users and captured businesses pass straight through", () => {
    harness.me = { ...harness.me, role: "firm_staff", consentCaptured: null };
    const { unmount } = renderGate();
    expect(screen.getByTestId("workspace")).toBeTruthy();
    unmount();
    harness.me = { ...harness.me, role: "client_user", consentCaptured: true };
    renderGate();
    expect(screen.getByTestId("workspace")).toBeTruthy();
  });

  test("Continue waits for both answers; a declined layer 1 says what it costs", () => {
    renderGate();
    const cont = screen.getByTestId(
      "button-consent-continue",
    ) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-consent-decline-1"));
    expect(cont.disabled).toBe(true);
    expect(
      screen.getByTestId("text-consent-decline-note-1").textContent,
    ).toMatch(/cannot submit or stamp/);
    fireEvent.click(screen.getByTestId("button-consent-allow-2"));
    expect(cont.disabled).toBe(false);
  });

  test("continuing records both decisions in one atomic command", async () => {
    renderGate();
    fireEvent.click(screen.getByTestId("button-consent-allow-1"));
    fireEvent.click(screen.getByTestId("button-consent-decline-2"));
    fireEvent.click(screen.getByTestId("button-consent-continue"));
    await waitFor(() => expect(harness.calls.length).toBe(1));
    expect(harness.calls).toEqual([
      {
        id: "cp-1",
        data: {
          commandId: expect.any(String),
          decisions: [
            { layer: 1, action: "grant" },
            { layer: 2, action: "revoke" },
          ],
        },
      },
    ]);
  });

  test("a ledger failure keeps the step on screen with the reason", async () => {
    harness.fail = true;
    renderGate();
    fireEvent.click(screen.getByTestId("button-consent-allow-1"));
    fireEvent.click(screen.getByTestId("button-consent-allow-2"));
    fireEvent.click(screen.getByTestId("button-consent-continue"));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByTestId("consent-capture")).toBeTruthy();
    expect(
      (screen.getByTestId("button-consent-continue") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
