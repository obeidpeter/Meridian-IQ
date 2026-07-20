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
  reset() {
    this.state.data = undefined;
    this.state.isPending = false;
    this.mutateCalls = [];
    this.callbacks = null;
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
  });
});
