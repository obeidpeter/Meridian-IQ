// @vitest-environment jsdom
import { test, expect, describe, afterEach, vi } from "vitest";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ClerkAnswer } from "@workspace/api-client-react";
import {
  AnswerCard,
  AskPanel,
  followupPinsLine,
  heldAnswer,
  holdsFollowupCase,
  planLine,
} from "./clerk-ask";

// Multi-turn Ask holds the last rendered answer in component state because
// TanStack v5 resets mutation.data the moment the next mutate() starts — the
// answer being followed up on must stay readable while (and after) the
// follow-up runs. heldAnswer is that state's reducer.

afterEach(cleanup);

const answer = (over: Partial<ClerkAnswer>): ClerkAnswer => ({
  answered: true,
  proposition: "VAT is 7.5% on standard-rated supplies.",
  citation: "VAT Act s.4",
  claimKey: "vat.standard-rate",
  claimVersion: 3,
  ...over,
});

describe("heldAnswer", () => {
  test("a successful ask replaces the held answer", () => {
    const first = answer({});
    const second = answer({ proposition: "₦1.2m is overdue.", dataIntent: "overdue" });
    expect(heldAnswer(null, { type: "success", answer: first })).toBe(first);
    expect(heldAnswer(first, { type: "success", answer: second })).toBe(second);
  });

  test("a refusal is still the newest answer — it replaces too", () => {
    const prev = answer({});
    const refusal = answer({
      answered: false,
      refusalReason: "No active claim covers this.",
    });
    expect(heldAnswer(prev, { type: "success", answer: refusal })).toBe(refusal);
  });

  test("a failed follow-up keeps the previous answer on screen", () => {
    const prev = answer({});
    expect(heldAnswer(prev, { type: "error" })).toBe(prev);
    // …and an error before any answer holds nothing, not a phantom.
    expect(heldAnswer(null, { type: "error" })).toBeNull();
  });

  test("a success with no answer payload clears to null rather than showing a stale answer", () => {
    const prev = answer({});
    expect(heldAnswer(prev, { type: "success", answer: undefined })).toBeNull();
    expect(heldAnswer(prev, { type: "success", answer: null })).toBeNull();
  });
});

// Ask 2.0 (contract 0.56.0): the holding rule widens — any answered reply
// carrying inheritable scope threads follow-ups, not just flat data answers.
// Semantically identical to the SME web app's and the mobile lib's copy.
describe("holdsFollowupCase", () => {
  test("a data answer threads, as before", () => {
    expect(
      holdsFollowupCase(answer({ dataIntent: "data.overdue_invoices" })),
    ).toBe(true);
  });

  test("a multi-intent answer (sections) threads even without a flat dataIntent", () => {
    expect(
      holdsFollowupCase(
        answer({
          sections: [{ title: "This month", text: "3 submitted.", facts: [] }],
        }),
      ),
    ).toBe(true);
  });

  test("pinned scope threads — machine pins included, display labels or not", () => {
    expect(
      holdsFollowupCase(answer({ pins: { monthLabel: "June 2026" } })),
    ).toBe(true);
    expect(
      holdsFollowupCase(answer({ pins: { clientPartyId: "party-1" } })),
    ).toBe(true);
  });

  test("register-claim answers, refusals, and empty carriers don't thread", () => {
    expect(holdsFollowupCase(null)).toBe(false);
    expect(holdsFollowupCase(undefined)).toBe(false);
    expect(holdsFollowupCase(answer({}))).toBe(false); // claim answer
    expect(
      holdsFollowupCase(
        answer({
          answered: false,
          refusalReason: "No active claim covers this.",
          pins: { monthLabel: "June 2026" },
        }),
      ),
    ).toBe(false);
    expect(holdsFollowupCase(answer({ sections: [], pins: {} }))).toBe(false);
    expect(holdsFollowupCase(answer({ pins: { monthLabel: "  " } }))).toBe(
      false,
    );
  });
});

describe("planLine", () => {
  test("joins the plan titles verbatim, in server order", () => {
    expect(
      planLine({
        plan: [
          { key: "data.submitted_this_month", title: "This month's submissions" },
          { key: "data.month_delta", title: "Month-on-month change" },
        ],
      }),
    ).toBe("Answered using: This month's submissions · Month-on-month change");
  });

  test("yields an empty string when there is no plan, so the line is omitted", () => {
    expect(planLine(undefined)).toBe("");
    expect(planLine(null)).toBe("");
    expect(planLine({})).toBe("");
    expect(planLine({ plan: [] })).toBe("");
    expect(planLine({ plan: [{ key: "a", title: "  " }] })).toBe("");
  });
});

describe("followupPinsLine", () => {
  test("shows the display pins a follow-up will keep", () => {
    expect(
      followupPinsLine({
        pins: { monthLabel: "June 2026", clientName: "Adaeze Foods Ltd" },
      }),
    ).toBe("Follow-ups keep: June 2026 · Adaeze Foods Ltd");
    expect(followupPinsLine({ pins: { monthLabel: "June 2026" } })).toBe(
      "Follow-ups keep: June 2026",
    );
  });

  test("yields an empty string when nothing displayable is pinned", () => {
    expect(followupPinsLine(undefined)).toBe("");
    expect(followupPinsLine(null)).toBe("");
    expect(followupPinsLine({ pins: {} })).toBe("");
    // Machine pins (ids, ISO dates) never render — display labels only.
    expect(
      followupPinsLine({
        pins: { monthStart: "2026-06-01", clientPartyId: "party-1" },
      }),
    ).toBe("");
  });
});

describe("AnswerCard sections rendering", () => {
  const multiAnswer = (): ClerkAnswer => ({
    answered: true,
    proposition: "Here's this month next to last month.",
    citation: "computed from the firm's records",
    plan: [
      { key: "data.submitted_this_month", title: "This month's submissions" },
      { key: "data.month_delta", title: "Month-on-month change" },
    ],
    pins: { monthLabel: "June 2026" },
    sections: [
      {
        title: "June 2026",
        text: "3 invoices were submitted.",
        dataIntent: "data.submitted_this_month",
        dataParams: { month: "June 2026" },
        facts: [{ key: "count", label: "Submitted", kind: "count", value: "3" }],
      },
      {
        title: "May 2026",
        text: "2 invoices were submitted.",
        dataIntent: "data.submitted_this_month",
        dataParams: { month: "May 2026" },
        facts: [{ key: "count", label: "Submitted", kind: "count", value: "2" }],
      },
    ],
  });

  test("a multi-intent answer renders the lead-in, the plan line, and each section with unique fact rows", () => {
    render(createElement(AnswerCard, { answer: multiAnswer() }));
    const card = screen.getByTestId("card-clerk-answer");
    expect(card.textContent).toContain("Here's this month next to last month.");
    expect(screen.getByTestId("text-answer-plan").textContent).toBe(
      "Answered using: This month's submissions · Month-on-month change",
    );
    // Both sections carry the fact key "count" — the section-indexed testid
    // keeps the rows unique.
    expect(screen.getByTestId("row-fact-0-count").textContent).toContain("3");
    expect(screen.getByTestId("row-fact-1-count").textContent).toContain("2");
    // Per-section scope lines, console idiom.
    expect(screen.getByTestId("text-section-scope-0").textContent).toBe(
      "scope: June 2026",
    );
    expect(screen.getByTestId("text-section-scope-1").textContent).toBe(
      "scope: May 2026",
    );
    // One source line for the whole answer.
    expect(card.textContent).toContain(
      "Source: computed from the firm's records",
    );
  });

  test("a single-intent answer renders none of the Ask 2.0 chrome — exactly today's card", () => {
    render(
      createElement(AnswerCard, {
        answer: answer({
          dataIntent: "data.overdue_invoices",
          dataParams: { month: "June 2026" },
          facts: [{ key: "count", label: "Overdue", kind: "count", value: "2" }],
        }),
      }),
    );
    const card = screen.getByTestId("card-clerk-answer");
    expect(screen.queryByTestId("text-answer-plan")).toBeNull();
    expect(screen.queryByTestId("section-answer-0")).toBeNull();
    expect(card.textContent).toContain("live lookup");
    expect(card.textContent).toContain("scope: June 2026");
  });
});

describe("AskPanel follow-up affordance", () => {
  const panelProps = {
    question: "",
    onQuestionChange: () => {},
    onAsk: () => {},
    isPending: false,
    answer: null,
  };

  test("shows what follow-ups keep and clears the thread on New topic", () => {
    const onClearFollowup = vi.fn();
    render(
      createElement(AskPanel, {
        ...panelProps,
        followupPins: "Follow-ups keep: June 2026 · Adaeze Foods Ltd",
        onClearFollowup,
      }),
    );
    expect(screen.getByTestId("chip-followup-pins").textContent).toBe(
      "Follow-ups keep: June 2026 · Adaeze Foods Ltd",
    );
    fireEvent.click(screen.getByTestId("button-clear-followup"));
    expect(onClearFollowup).toHaveBeenCalledTimes(1);
  });

  test("no pinned scope, no chip", () => {
    render(createElement(AskPanel, { ...panelProps, followupPins: "" }));
    expect(screen.queryByTestId("chip-followup-pins")).toBeNull();
    expect(screen.queryByTestId("button-clear-followup")).toBeNull();
  });
});
