// @vitest-environment jsdom
// The console "Clerk suggests" card — the SME dashboard card's firm-side
// twin. The pins that matter:
//  - F1: the card (and its OPEN results dialog) must survive the proposals
//    query refetching to an empty list — after a full batch the refetched
//    list is [] and an early return would unmount the results mid-read.
//  - closeDialog is a no-op while the execute mutation is in flight: a batch
//    cannot be cancelled from here, so its result is always shown.
//  - The proposals/decisions invalidations are deferred to closeDialog and
//    fire only when a decision exists — never immediately on success, never
//    on a cancelled confirmation.
//  - Every contract outcome renders through the shared vocabulary in
//    @workspace/format (no raw enum string leaks into the dialog).
//  - Chaser drafts render subject/body and copy as "subject\n\nbody".
// Plus the console-only mount rule: past decisions keep the card visible
// even when a dark clerk_actions flag empties the proposals.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ActionProposal,
  ActionProposals,
  ActionTarget,
  ActionTargetOutcome,
  ClerkActionDecision,
  ExecuteActionResult,
  PaymentChaserDraft,
} from "@workspace/api-client-react";

// Controllable stand-ins for the three generated hooks the card renders
// with. The rest of the module stays real — in particular the query-key
// builders, so the invalidation assertions compare against genuine keys.
const harness = vi.hoisted(() => ({
  proposals: {
    data: undefined as unknown,
    isSuccess: false,
  },
  decisions: {
    data: undefined as unknown,
  },
  execute: {
    calls: [] as unknown[],
    pending: false,
    result: null as unknown,
  },
  reset() {
    this.proposals.data = undefined;
    this.proposals.isSuccess = false;
    this.decisions.data = undefined;
    this.execute.calls = [];
    this.execute.pending = false;
    this.execute.result = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetActionProposals: () => ({
      data: harness.proposals.data,
      isSuccess: harness.proposals.isSuccess,
    }),
    useGetActionDecisions: () => ({
      data: harness.decisions.data,
    }),
    useExecuteAction: () => ({
      // Getter so the object handed to the handlers always reflects the
      // in-flight state, exactly like a live mutation object would.
      get isPending() {
        return harness.execute.pending;
      },
      mutateAsync: (vars: unknown) => {
        harness.execute.calls.push(vars);
        return Promise.resolve(harness.execute.result);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import { ClerkActionsCard } from "./clerk-actions-card";
import {
  ActionTargetOutcomeOutcome,
  getGetActionDecisionsQueryKey,
  getGetActionProposalsQueryKey,
  getGetClientPortfolioQueryKey,
} from "@workspace/api-client-react";
import { ACTION_OUTCOME_LABELS } from "@/lib/format";

function target(invoiceId: string, invoiceNumber: string): ActionTarget {
  return {
    invoiceId,
    invoiceNumber,
    issueDate: "2026-06-01",
    daysOverdue: 30,
    grandTotal: "10000.00",
    currency: "NGN",
    note: null,
  };
}

function proposal(over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    kind: "submit_overdue",
    title: "Submit 2 overdue invoices",
    why: "Two invoices are past the statutory window.",
    targets: [target("inv-1", "INV-001"), target("inv-2", "INV-002")],
    targetCount: 2,
    truncated: false,
    evidence: {},
    ...over,
  };
}

function proposals(actions: ActionProposal[]): ActionProposals {
  return { actions, note: "Nothing runs until a firm user approves." };
}

function decision(
  targets: ActionTargetOutcome[],
  over: Partial<ClerkActionDecision> = {},
): ClerkActionDecision {
  const executed = targets.filter(
    (t) => t.outcome === "submitted" || t.outcome === "drafted",
  ).length;
  const skipped = targets.filter(
    (t) => t.outcome === "skipped_not_eligible",
  ).length;
  return {
    id: "dec-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    kind: "submit_overdue",
    decidedBy: "u-1",
    evidence: {},
    targets,
    requestedCount: targets.length,
    executedCount: executed,
    skippedCount: skipped,
    failedCount: targets.length - executed - skipped,
    createdAt: "2026-07-29T10:00:00Z",
    ...over,
  };
}

function chaserDraft(): PaymentChaserDraft {
  return {
    invoiceId: "inv-1",
    invoiceNumber: "INV-001",
    buyerName: "Zenith Retail",
    subject: "Payment reminder for INV-001",
    body: "Good day,\n\nINV-001 is now due. Kindly arrange payment.",
    source: "template",
    stage: 1,
    previousReminders: { count: 0, lastAt: null },
  };
}

// The card reads the query client from context; the spy records every
// invalidation's key so the deferred-refetch contract can be asserted.
function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  const ui = (
    <QueryClientProvider client={qc}>
      <ClerkActionsCard clientPartyId="cp-1" />
    </QueryClientProvider>
  );
  const view = render(ui);
  return {
    invalidatedKeys: () =>
      spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey),
    rerenderCard: () => view.rerender(ui),
  };
}

// Clicks run async handlers (the execute mutation resolves in a microtask);
// act(async …) flushes them before assertions.
const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

// Drive the card from proposal to the results view: approve → confirm, with
// the mutation resolving to `result`.
async function openResults(
  result: ExecuteActionResult,
  kind = "submit_overdue",
) {
  harness.execute.result = result;
  await click(screen.getByTestId(`button-approve-${kind}`));
  await click(screen.getByTestId("button-confirm-action"));
  expect(screen.getByText("Batch result")).toBeTruthy();
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
  harness.proposals.data = proposals([proposal()]);
  harness.proposals.isSuccess = true;
  harness.decisions.data = { decisions: [] };
});

describe("ClerkActionsCard (console)", () => {
  test("F1: the open results dialog survives the proposals list refetching to empty", async () => {
    const { rerenderCard } = renderCard();
    await openResults({
      decision: decision([
        { invoiceId: "inv-1", invoiceNumber: "INV-001", outcome: "submitted", error: null },
        { invoiceId: "inv-2", invoiceNumber: "INV-002", outcome: "submitted", error: null },
      ]),
      drafts: null,
    });

    // The full batch went through: the proposals query refetches to [] (as
    // it will after closeDialog invalidates it). With no decision history
    // either, only the open dialog keeps the card mounted — the early
    // return must not fire mid-read.
    harness.proposals.data = proposals([]);
    rerenderCard();
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    expect(screen.getByText("Batch result")).toBeTruthy();
    expect(screen.getByTestId("outcome-inv-1").textContent).toContain(
      "Submitted",
    );
  });

  test("closeDialog is a no-op while the execute mutation is in flight", async () => {
    const { invalidatedKeys, rerenderCard } = renderCard();
    await openResults({
      decision: decision([
        { invoiceId: "inv-1", invoiceNumber: "INV-001", outcome: "submitted", error: null },
      ]),
      drafts: null,
    });

    // A batch in flight (isPending): Done must hold the dialog open — its
    // result would otherwise never be shown.
    harness.execute.pending = true;
    rerenderCard();
    await click(screen.getByTestId("button-close-action"));
    expect(screen.getByText("Batch result")).toBeTruthy();
    expect(invalidatedKeys()).not.toContainEqual(
      getGetActionProposalsQueryKey(),
    );

    // Once the flight lands, the same click closes normally.
    harness.execute.pending = false;
    rerenderCard();
    await click(screen.getByTestId("button-close-action"));
    expect(screen.queryByText("Batch result")).toBeNull();
  });

  test("proposals/decisions invalidations fire only on close after a decision", async () => {
    const { invalidatedKeys } = renderCard();

    // Opening and cancelling the confirmation touches nothing.
    await click(screen.getByTestId("button-approve-submit_overdue"));
    await click(screen.getByText("Cancel"));
    expect(invalidatedKeys()).toEqual([]);

    await openResults({
      decision: decision([
        { invoiceId: "inv-1", invoiceNumber: "INV-001", outcome: "submitted", error: null },
      ]),
      drafts: null,
    });

    // Success refreshes the client portfolio immediately, but the
    // proposals/decisions refetch is deferred so the open dialog's backing
    // list cannot empty underneath it.
    const afterSuccess = invalidatedKeys();
    expect(afterSuccess).toContainEqual(getGetClientPortfolioQueryKey("cp-1"));
    expect(afterSuccess).not.toContainEqual(getGetActionProposalsQueryKey());
    expect(afterSuccess).not.toContainEqual(getGetActionDecisionsQueryKey());

    await click(screen.getByTestId("button-close-action"));
    const afterClose = invalidatedKeys();
    expect(afterClose).toContainEqual(getGetActionProposalsQueryKey());
    expect(afterClose).toContainEqual(getGetActionDecisionsQueryKey());
  });

  test("every contract outcome renders its shared mapped label — no raw enum leaks", async () => {
    const outcomes = Object.values(ActionTargetOutcomeOutcome);
    renderCard();
    await openResults({
      decision: decision(
        outcomes.map((outcome, i) => ({
          invoiceId: `inv-${i}`,
          invoiceNumber: `N${i}`,
          outcome,
          error: null,
        })),
      ),
      drafts: null,
    });

    outcomes.forEach((outcome, i) => {
      // The row is exactly invoice number + the vocabulary label: any raw
      // enum string ("skipped_not_eligible") would fail the equality.
      expect(screen.getByTestId(`outcome-inv-${i}`).textContent).toBe(
        `N${i}${ACTION_OUTCOME_LABELS[outcome]}`,
      );
    });

    // The tone wiring goes through the shared helper, not a local ternary.
    const toneOf = (i: number) =>
      screen.getByTestId(`outcome-inv-${i}`).querySelector("span:last-child")
        ?.className;
    expect(toneOf(outcomes.indexOf("submitted"))).toBe(
      "text-emerald-700 dark:text-emerald-400",
    );
    expect(toneOf(outcomes.indexOf("skipped_not_eligible"))).toBe(
      "text-muted-foreground",
    );
    expect(toneOf(outcomes.indexOf("failed"))).toBe(
      "text-amber-700 dark:text-amber-400",
    );
  });

  test("chaser drafts render subject/body and copy as subject + blank line + body", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const draft = chaserDraft();
    harness.proposals.data = proposals([
      proposal({ kind: "draft_chasers", title: "Draft 1 payment reminder" }),
    ]);
    renderCard();
    await openResults(
      {
        decision: decision(
          [{ invoiceId: "inv-1", invoiceNumber: "INV-001", outcome: "drafted", error: null }],
          { kind: "draft_chasers" },
        ),
        drafts: [draft],
      },
      "draft_chasers",
    );

    const card = screen.getByTestId("draft-inv-1");
    expect(card.textContent).toContain(draft.subject);
    expect(card.textContent).toContain("Kindly arrange payment.");
    await click(screen.getByTestId("button-copy-draft-inv-1"));
    expect(writeText).toHaveBeenCalledWith(`${draft.subject}\n\n${draft.body}`);
  });

  test("past decisions keep the card visible when the proposals list is empty", () => {
    // A dark clerk_actions flag answers an empty proposals list, but the
    // decision strip is the firm's durable record of who approved what.
    harness.proposals.data = proposals([]);
    harness.decisions.data = {
      decisions: [
        decision([
          { invoiceId: "inv-1", invoiceNumber: "INV-001", outcome: "submitted", error: null },
        ]),
      ],
    };
    renderCard();
    expect(screen.getByTestId("card-clerk-actions")).toBeTruthy();
    expect(screen.getByTestId("decision-dec-1").textContent).toContain(
      "1 executed",
    );
  });
});
