// @vitest-environment jsdom
// PaymentReminderCard's chase-ladder invariant: the reminder log records what
// the client actually SENT, and the next draft's stage keys off the row
// count — so a copy must log exactly once. Double-logging (e.g. two rapid
// copy clicks racing the first log's response) would falsely escalate the
// ladder's tone.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  Invoice,
  PaymentChaserDraft,
} from "@workspace/api-client-react";

// Controllable stand-ins for the three generated hooks the card uses. The
// rest of the module stays real (the page imports many hooks; only these
// three render here).
const harness = vi.hoisted(() => ({
  draft: {
    data: undefined as PaymentChaserDraft | undefined,
    isPending: false,
    isError: false,
    mutateCalls: [] as unknown[],
  },
  log: {
    calls: [] as unknown[],
    pending: false,
    // Resolves the most recent in-flight log the way the server would.
    deliverSuccess: null as ((s: { stage: number }) => void) | null,
  },
  reset() {
    this.draft.data = undefined;
    this.draft.isPending = false;
    this.draft.isError = false;
    this.draft.mutateCalls = [];
    this.log.calls = [];
    this.log.pending = false;
    this.log.deliverSuccess = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useDraftPaymentChaser: () => ({
      data: harness.draft.data,
      isPending: harness.draft.isPending,
      isError: harness.draft.isError,
      mutate: (vars: unknown) => harness.draft.mutateCalls.push(vars),
    }),
    useRecordChaseReminder: () => ({
      // Getter so the object handed to the click handler always reflects the
      // in-flight state, exactly like a live mutation object would.
      get isPending() {
        return harness.log.pending;
      },
      mutate: (
        vars: unknown,
        opts?: { onSuccess?: (s: { stage: number }) => void },
      ) => {
        harness.log.calls.push(vars);
        harness.log.pending = true;
        harness.log.deliverSuccess = (s) => {
          harness.log.pending = false;
          opts?.onSuccess?.(s);
        };
      },
    }),
    useListPaymentBehaviour: () => ({ data: undefined }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { PaymentReminderCard } from "./invoice-detail";

const invoice = {
  id: "inv-1",
  supplierPartyId: "sup-1",
  buyerPartyId: "buy-1",
} as unknown as Invoice;

function chaserDraft(stage: number): PaymentChaserDraft {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-001",
    buyerName: "Zenith Retail",
    subject: "Payment reminder for INV-001",
    body: "Please pay when you can.",
    source: "template",
    stage,
    previousReminders: { count: stage - 1, lastAt: null },
  };
}

function mockClipboard(writeText: () => Promise<void>) {
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

const copyButton = () => screen.getByTestId("button-copy-chaser");

// Clicks run an async handler (clipboard write, then the log decision);
// act(async …) flushes the microtasks before assertions.
const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("PaymentReminderCard chase-ladder logging", () => {
  test("drafting and redrafting never log a reminder", async () => {
    const { rerender } = render(<PaymentReminderCard invoice={invoice} />);
    await click(screen.getByTestId("button-draft-chaser"));
    expect(harness.draft.mutateCalls).toHaveLength(1);
    expect(harness.log.calls).toHaveLength(0);

    // With a draft on screen, "Redraft" still logs nothing — only copying
    // (i.e. actually taking the letter to send) counts as a reminder.
    harness.draft.data = chaserDraft(1);
    rerender(<PaymentReminderCard invoice={invoice} />);
    await click(screen.getByText("Redraft"));
    expect(harness.draft.mutateCalls).toHaveLength(2);
    expect(harness.log.calls).toHaveLength(0);
  });

  test("copy logs once per stage, even across rapid clicks", async () => {
    mockClipboard(vi.fn(() => Promise.resolve()));
    harness.draft.data = chaserDraft(1);
    const { rerender } = render(<PaymentReminderCard invoice={invoice} />);

    await click(copyButton());
    expect(harness.log.calls).toEqual([{ invoiceId: "inv-1" }]);

    // Second copy while the first log is still in flight: the isPending
    // guard must hold the line (loggedStage only updates onSuccess, so it
    // alone would let this double-log).
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(1);

    // The log lands; copying the same draft again still logs nothing more.
    act(() => harness.log.deliverSuccess?.({ stage: 1 }));
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(1);

    // A redrafted next stage is a NEW reminder: copying it logs again.
    harness.draft.data = chaserDraft(2);
    rerender(<PaymentReminderCard invoice={invoice} />);
    await click(copyButton());
    expect(harness.log.calls).toHaveLength(2);
  });

  test("a denied clipboard skips the log (nothing was copied to send)", async () => {
    mockClipboard(vi.fn(() => Promise.reject(new Error("denied"))));
    harness.draft.data = chaserDraft(1);
    render(<PaymentReminderCard invoice={invoice} />);

    await click(copyButton());
    expect(harness.log.calls).toHaveLength(0);
    // No false "Copied" feedback either — the text stays on screen to copy
    // by hand.
    expect(copyButton().textContent).toBe("Copy to clipboard");
  });
});
