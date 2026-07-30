// @vitest-environment jsdom
// Ask Clerk's answer persistence: the rendered answer is held in page state,
// not read off the mutation, because submitting a follow-up resets the
// mutation's data — which used to blank the very answer being followed up on
// (and never bring it back if the follow-up errored).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClerkAnswer, ClerkCase } from "@workspace/api-client-react";

// A controllable stand-in for the generated useAskClerk mutation hook,
// faithful to react-query's lifecycle: mutate() RESETS data and goes
// pending; success sets data and fires onSuccess; error leaves data unset.
const harness = vi.hoisted(() => ({
  state: {
    data: undefined as unknown,
    isPending: false,
  },
  mutateCalls: [] as unknown[],
  callbacks: null as null | {
    onSuccess?: (row: unknown) => void;
    onError?: (err: unknown) => void;
  },
  // The feedback mutation (AnswerCard): a plain generated hook, stubbed so
  // the card needs no QueryClientProvider. Per-call options (onError) are
  // held so a test can settle the write either way.
  feedback: {
    calls: [] as unknown[],
    lastOptions: null as null | { onError?: (err: unknown) => void },
    isPending: false,
  },
  reset() {
    this.state.data = undefined;
    this.state.isPending = false;
    this.mutateCalls = [];
    this.callbacks = null;
    this.feedback.calls = [];
    this.feedback.lastOptions = null;
    this.feedback.isPending = false;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useAskClerk: (opts?: {
      mutation?: {
        onSuccess?: (row: unknown) => void;
        onError?: (err: unknown) => void;
      };
    }) => {
      harness.callbacks = opts?.mutation ?? null;
      return {
        data: harness.state.data,
        isPending: harness.state.isPending,
        mutate: (vars: unknown) => {
          harness.mutateCalls.push(vars);
          // The reset that motivated holding the answer in page state.
          harness.state.data = undefined;
          harness.state.isPending = true;
        },
      };
    },
    useSubmitClerkFeedback: () => ({
      isPending: harness.feedback.isPending,
      mutate: (
        vars: unknown,
        options?: { onError?: (err: unknown) => void },
      ) => {
        harness.feedback.calls.push(vars);
        harness.feedback.lastOptions = options ?? null;
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-in.
import { AskContent } from "./clerk-ask";

function dataAnswer(proposition: string): ClerkAnswer {
  return {
    answered: true,
    proposition,
    citation: "computed from your invoices",
    dataIntent: "data.submitted_this_month",
    dataParams: { month: "July 2026" },
  };
}

// Server-side success payload: the answered question case.
function answeredCase(id: string, answer: ClerkAnswer): ClerkCase {
  return { id, answer } as unknown as ClerkCase;
}

const askQuestion = (text: string) => {
  fireEvent.change(screen.getByTestId("input-ask-question"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByTestId("button-ask"));
};

// The server answers: settle the mutation the way react-query would — data
// set, no longer pending — then fire onSuccess.
const deliver = (row: ClerkCase) =>
  act(() => {
    harness.state.isPending = false;
    harness.state.data = row;
    harness.callbacks?.onSuccess?.(row);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("AskContent answer persistence", () => {
  test("the shown answer survives an in-flight follow-up and a follow-up error, and is replaced on success", () => {
    render(<AskContent />);

    askQuestion("What did we submit this month?");
    expect(harness.mutateCalls).toEqual([
      { data: { question: "What did we submit this month?" } },
    ]);
    deliver(answeredCase("case-1", dataAnswer("3 invoices were submitted.")));
    const card = () => screen.getByTestId("card-clerk-answer");
    expect(card().textContent).toContain("3 invoices were submitted.");

    // Follow-up in flight: the mutation's data resets, but the answer being
    // followed up on must stay on screen. The follow-up also threads the
    // previous data answer's case id.
    askQuestion("and for June?");
    expect(harness.mutateCalls[1]).toEqual({
      data: { question: "and for June?", previousCaseId: "case-1" },
    });
    expect(card().textContent).toContain("3 invoices were submitted.");

    // Follow-up errors: the previous answer is retained, not lost.
    act(() => {
      harness.state.isPending = false;
      harness.callbacks?.onError?.({ status: 500, data: { error: "boom" } });
    });
    expect(card().textContent).toContain("3 invoices were submitted.");

    // A later success replaces it.
    askQuestion("and for June?");
    deliver(
      answeredCase("case-2", dataAnswer("June: 2 invoices were submitted.")),
    );
    expect(card().textContent).toContain("June: 2 invoices were submitted.");
    expect(card().textContent).not.toContain("3 invoices were submitted.");
  });

  test("a refusal replaces the previous answer too — stale numbers must not outlive the newest reply", () => {
    render(<AskContent />);
    askQuestion("What did we submit this month?");
    deliver(answeredCase("case-1", dataAnswer("3 invoices were submitted.")));
    askQuestion("Who owes the firm?");
    deliver(
      answeredCase("case-2", {
        answered: false,
        refusalReason: "That isn't covered by an approved claim.",
      }),
    );
    expect(screen.queryByTestId("card-clerk-answer")).toBeNull();
    expect(screen.getByTestId("card-clerk-refusal").textContent).toContain(
      "That isn't covered by an approved claim.",
    );
  });

  test("a success WITHOUT an answer payload clears the held answer — console's tested semantic", () => {
    render(<AskContent />);
    askQuestion("What did we submit this month?");
    deliver(answeredCase("case-1", dataAnswer("3 invoices were submitted.")));
    expect(screen.getByTestId("card-clerk-answer")).toBeTruthy();

    // A later success that carries no answer (older server / degenerate
    // payload) must not leave the stale numbers on screen.
    askQuestion("and for June?");
    deliver({ id: "case-2" } as unknown as ClerkCase);
    expect(screen.queryByTestId("card-clerk-answer")).toBeNull();
    expect(screen.queryByTestId("card-clerk-refusal")).toBeNull();
  });

  test("suggested chips stay on the client-safe data intents", () => {
    render(<AskContent />);
    const chips = screen.getByTestId("chips-suggested-questions");
    // The aged-receivables phrasing replaced "Who owes us?", which lands in
    // data.outstanding_receivables — an intent the server refuses for
    // client_users (CLIENT_SAFE_DATA_INTENTS).
    expect(chips.textContent).toContain("What's been outstanding longest?");
    expect(chips.textContent).not.toContain("Who owes us?");
    // Ask 2.0's delta chip, appended fifth — byte-identical in the mobile app.
    expect(chips.textContent).toContain(
      "How does this month compare to last month?",
    );
  });
});

describe("AnswerCard links and feedback", () => {
  test("invoice links render as root-relative /invoices/<id> buttons; id-less links are dropped", () => {
    render(<AskContent />);
    askQuestion("What's overdue?");
    deliver(
      answeredCase("case-1", {
        ...dataAnswer("2 invoices are overdue."),
        links: [
          { label: "INV-001", kind: "invoice", id: "inv-1" },
          { label: "INV-002", kind: "invoice", id: null },
        ],
      }),
    );
    const link = screen.getByTestId("link-answer-invoice-inv-1");
    expect(link.getAttribute("href")).toBe("/invoices/inv-1");
    expect(link.textContent).toBe("INV-001");
    // The id-less link never becomes a dead button.
    expect(screen.queryByText("INV-002")).toBeNull();
  });

  test("thumbs submit feedback on the answered case, reflect the selection, allow switching, and ignore a repeat press", () => {
    render(<AskContent />);
    askQuestion("What's overdue?");
    deliver(answeredCase("case-1", dataAnswer("2 invoices are overdue.")));

    const helpful = () => screen.getByTestId("button-feedback-helpful");
    const notHelpful = () => screen.getByTestId("button-feedback-not-helpful");
    expect(helpful().getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(helpful());
    expect(harness.feedback.calls).toEqual([
      { id: "case-1", data: { helpful: true } },
    ]);
    expect(helpful().getAttribute("aria-pressed")).toBe("true");

    // The same thumb again is a no-op — nothing new to tell the server.
    fireEvent.click(helpful());
    expect(harness.feedback.calls).toHaveLength(1);

    // Switching submits the new signal and moves the selection.
    fireEvent.click(notHelpful());
    expect(harness.feedback.calls[1]).toEqual({
      id: "case-1",
      data: { helpful: false },
    });
    expect(notHelpful().getAttribute("aria-pressed")).toBe("true");
    expect(helpful().getAttribute("aria-pressed")).toBe("false");
  });

  test("a failed feedback write reverts the optimistic selection", () => {
    render(<AskContent />);
    askQuestion("What's overdue?");
    deliver(answeredCase("case-1", dataAnswer("2 invoices are overdue.")));

    fireEvent.click(screen.getByTestId("button-feedback-helpful"));
    expect(
      screen.getByTestId("button-feedback-helpful").getAttribute("aria-pressed"),
    ).toBe("true");
    act(() => {
      harness.feedback.lastOptions?.onError?.({ status: 500 });
    });
    expect(
      screen.getByTestId("button-feedback-helpful").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  test("a fresh answer resets the feedback selection — the card is keyed by case", () => {
    render(<AskContent />);
    askQuestion("What's overdue?");
    deliver(answeredCase("case-1", dataAnswer("2 invoices are overdue.")));
    fireEvent.click(screen.getByTestId("button-feedback-helpful"));
    expect(
      screen.getByTestId("button-feedback-helpful").getAttribute("aria-pressed"),
    ).toBe("true");

    askQuestion("and for June?");
    deliver(answeredCase("case-2", dataAnswer("June: 1 invoice is overdue.")));
    expect(
      screen.getByTestId("button-feedback-helpful").getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("button-feedback-not-helpful"));
    expect(harness.feedback.calls[1]).toEqual({
      id: "case-2",
      data: { helpful: false },
    });
  });
});

// Ask 2.0 (contract 0.56.0): multi-intent answers carry sections under a
// lead-in proposition, a plan-transparency line, and pinned follow-up scope.
// Single-intent answers carry none of it and must render exactly as before.
describe("Ask 2.0 sections, plan, and follow-up pins", () => {
  const multiAnswer = (): ClerkAnswer => ({
    answered: true,
    proposition: "Here's this month next to last month.",
    citation: "computed from your invoices",
    plan: [
      { key: "data.submitted_this_month", title: "This month's submissions" },
      { key: "data.month_delta", title: "Month-on-month change" },
    ],
    pins: {
      monthStart: "2026-06-01",
      monthLabel: "June 2026",
      clientPartyId: "party-1",
      clientName: "Adaeze Foods Ltd",
    },
    sections: [
      {
        title: "June 2026",
        text: "3 invoices were submitted.",
        dataIntent: "data.submitted_this_month",
        dataParams: { month: "June 2026" },
        facts: [
          { key: "count", label: "Submitted", kind: "count", value: "3" },
        ],
        links: [
          { label: "INV-001", kind: "invoice", id: "inv-1" },
          { label: "INV-002", kind: "invoice", id: null },
        ],
      },
      {
        title: "May 2026",
        text: "2 invoices were submitted.",
        dataIntent: "data.submitted_this_month",
        dataParams: { month: "May 2026" },
        facts: [
          { key: "count", label: "Submitted", kind: "count", value: "2" },
        ],
      },
    ],
  });

  test("a multi-intent answer renders the lead-in, the plan line, and each section with unique fact rows", () => {
    render(<AskContent />);
    askQuestion("How does this month compare to last month?");
    deliver(answeredCase("case-1", multiAnswer()));

    const card = screen.getByTestId("card-clerk-answer");
    expect(card.textContent).toContain("Here's this month next to last month.");
    expect(screen.getByTestId("text-answer-plan").textContent).toBe(
      "Answered using: This month's submissions · Month-on-month change",
    );

    // Section blocks: title, text, and SECTION-INDEXED fact rows — both
    // sections carry the fact key "count", so the flat row testid would
    // collide; the indexed one cannot.
    expect(screen.getByTestId("section-answer-0").textContent).toContain(
      "June 2026",
    );
    expect(screen.getByTestId("section-answer-1").textContent).toContain(
      "May 2026",
    );
    expect(screen.getByTestId("row-fact-0-count").textContent).toContain("3");
    expect(screen.getByTestId("row-fact-1-count").textContent).toContain("2");
    expect(screen.queryByTestId("row-fact-count")).toBeNull();

    // Section links keep the app's invoice-link contract: root-relative
    // href, id-less links dropped.
    const link = screen.getByTestId("link-answer-invoice-inv-1");
    expect(link.getAttribute("href")).toBe("/invoices/inv-1");
    expect(screen.queryByText("INV-002")).toBeNull();

    // Per-section scope lines carry each lookup's resolved labels.
    expect(screen.getByTestId("text-section-scope-0").textContent).toBe(
      "June 2026",
    );
    expect(screen.getByTestId("text-section-scope-1").textContent).toBe(
      "May 2026",
    );

    // One source line for the whole answer, and feedback still offered.
    expect(screen.getByTestId("text-answer-from-records").textContent).toContain(
      "computed from your invoices",
    );
    expect(screen.getByTestId("button-feedback-helpful")).toBeTruthy();
  });

  test("a single-intent answer renders none of the Ask 2.0 chrome", () => {
    render(<AskContent />);
    askQuestion("What did we submit this month?");
    deliver(
      answeredCase("case-1", {
        ...dataAnswer("3 invoices were submitted."),
        facts: [
          { key: "count", label: "Submitted", kind: "count", value: "3" },
        ],
      }),
    );
    // Flat fact rows keep their un-indexed testid, untouched.
    expect(screen.getByTestId("row-fact-count")).toBeTruthy();
    expect(screen.queryByTestId("text-answer-plan")).toBeNull();
    expect(screen.queryByTestId("section-answer-0")).toBeNull();
    expect(screen.queryByTestId("chip-followup-pins")).toBeNull();
  });

  test("a sectioned answer threads follow-ups even without a flat dataIntent, and shows what they keep", () => {
    render(<AskContent />);
    askQuestion("How does this month compare to last month?");
    deliver(answeredCase("case-1", multiAnswer()));

    // The pinned display scope shows near the input…
    expect(screen.getByTestId("chip-followup-pins").textContent).toBe(
      "Follow-ups keep: June 2026 · Adaeze Foods Ltd",
    );

    // …and the next question threads the sectioned case's id.
    askQuestion("and for Adaeze only?");
    expect(harness.mutateCalls[1]).toEqual({
      data: { question: "and for Adaeze only?", previousCaseId: "case-1" },
    });
  });

  test("New topic drops the thread: the chip disappears and the next ask carries no previousCaseId", () => {
    render(<AskContent />);
    askQuestion("How does this month compare to last month?");
    deliver(answeredCase("case-1", multiAnswer()));
    expect(screen.getByTestId("chip-followup-pins")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-clear-followup"));
    expect(screen.queryByTestId("chip-followup-pins")).toBeNull();
    // The answer itself stays on screen — only the thread is dropped.
    expect(screen.getByTestId("card-clerk-answer")).toBeTruthy();

    askQuestion("What's overdue?");
    expect(harness.mutateCalls[1]).toEqual({
      data: { question: "What's overdue?" },
    });
  });

  test("a data answer without display pins threads silently — no chip, exactly today's UX", () => {
    render(<AskContent />);
    askQuestion("What did we submit this month?");
    deliver(answeredCase("case-1", dataAnswer("3 invoices were submitted.")));
    expect(screen.queryByTestId("chip-followup-pins")).toBeNull();
    askQuestion("and for June?");
    expect(harness.mutateCalls[1]).toEqual({
      data: { question: "and for June?", previousCaseId: "case-1" },
    });
  });

  test("an answered reply carrying only pins threads too", () => {
    render(<AskContent />);
    askQuestion("What about Adaeze Foods?");
    deliver(
      answeredCase("case-1", {
        answered: true,
        proposition: "Adaeze Foods Ltd has 2 open invoices.",
        citation: "computed from your invoices",
        pins: { clientPartyId: "party-1", clientName: "Adaeze Foods Ltd" },
      }),
    );
    expect(screen.getByTestId("chip-followup-pins").textContent).toBe(
      "Follow-ups keep: Adaeze Foods Ltd",
    );
    askQuestion("and last month?");
    expect(harness.mutateCalls[1]).toEqual({
      data: { question: "and last month?", previousCaseId: "case-1" },
    });
  });
});
