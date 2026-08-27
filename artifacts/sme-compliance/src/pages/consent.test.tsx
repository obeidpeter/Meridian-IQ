// @vitest-environment jsdom
// The consent page (CORE-03): granting stays one click, but revoking is a
// permanent ledger event that darkens dependent features — so the Revoke
// button only ARMS a confirm dialog, and the mutation fires solely from the
// dialog's confirm action. Copy leads with the layer's meaning ("Anonymized
// benchmarking"), with the layer number as a small suffix.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type { ConsentRecord } from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  records: [] as unknown[],
  // Every (vars, callbacks) pair record.mutate was called with, in order.
  mutateCalls: [] as [unknown, Record<string, (...args: unknown[]) => void>][],
  toast: vi.fn(),
  reset() {
    this.records = [];
    this.mutateCalls = [];
    this.toast.mockReset();
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetMe: () => ({
      data: { clientPartyId: "cp-1", capabilities: ["consent.write"] },
    }),
    useListConsent: () => ({
      data: harness.records,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordConsent: () => ({
      isPending: false,
      mutate: (
        vars: unknown,
        callbacks: Record<string, (...args: unknown[]) => void>,
      ) => {
        harness.mutateCalls.push([vars, callbacks]);
      },
    }),
  };
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: harness.toast }),
}));

// Import AFTER the mocks so the page module binds the stand-ins.
import { Consent } from "./consent";

function grantRecord(over: Partial<ConsentRecord> = {}): ConsentRecord {
  return {
    id: "cr-1",
    partyId: "cp-1",
    layer: 2,
    action: "grant",
    scope: "anonymized_benchmark",
    basis: "consent",
    channel: "app",
    createdAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

const renderPage = () => renderWithClient(<Consent />);

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("revoke confirm gate", () => {
  test("Revoke arms the dialog without recording anything", () => {
    harness.records = [grantRecord()];
    renderPage();

    fireEvent.click(screen.getByTestId("button-revoke-2"));
    expect(harness.mutateCalls).toHaveLength(0);
    const confirm = screen.getByTestId("button-confirm-revoke");
    expect(confirm).toBeTruthy();
    // The dialog names the layer by meaning, not number.
    expect(screen.getByText(/Revoke Anonymized benchmarking\?/)).toBeTruthy();
  });

  test("confirming records the revoke ledger event", () => {
    harness.records = [grantRecord()];
    renderPage();

    fireEvent.click(screen.getByTestId("button-revoke-2"));
    fireEvent.click(screen.getByTestId("button-confirm-revoke"));
    expect(harness.mutateCalls).toHaveLength(1);
    expect(harness.mutateCalls[0][0]).toEqual({
      id: "cp-1",
      data: {
        layer: 2,
        action: "revoke",
        scope: "anonymized_benchmark",
        basis: "consent",
        channel: "app",
      },
    });
  });

  test("Keep consent closes the dialog with zero mutations", () => {
    harness.records = [grantRecord()];
    renderPage();

    fireEvent.click(screen.getByTestId("button-revoke-2"));
    fireEvent.click(screen.getByText("Keep consent"));
    expect(harness.mutateCalls).toHaveLength(0);
    expect(screen.queryByTestId("button-confirm-revoke")).toBeNull();
  });

  test("granting stays one-click", () => {
    harness.records = [];
    renderPage();

    fireEvent.click(screen.getByTestId("button-grant-2"));
    expect(harness.mutateCalls).toHaveLength(1);
    expect(harness.mutateCalls[0][0]).toEqual({
      id: "cp-1",
      data: {
        layer: 2,
        action: "grant",
        scope: "anonymized_benchmark",
        basis: "consent",
        channel: "app",
      },
    });
  });
});

describe("plain-language copy", () => {
  test("the layer card leads with its meaning, layer number as suffix", () => {
    harness.records = [];
    renderPage();

    const card = screen.getByTestId("consent-layer-2");
    expect(card.textContent).toContain("Anonymized benchmarking");
    expect(card.textContent).toContain("Layer 2");
    // The title precedes the layer suffix.
    expect(
      card.textContent!.indexOf("Anonymized benchmarking"),
    ).toBeLessThan(card.textContent!.indexOf("Layer 2"));
  });

  test("the success toast names the scope, not a bare layer number", () => {
    harness.records = [];
    renderPage();

    fireEvent.click(screen.getByTestId("button-grant-2"));
    const [, callbacks] = harness.mutateCalls[0];
    callbacks.onSuccess();
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Consent granted — Anonymized benchmarking",
      }),
    );
  });
});
