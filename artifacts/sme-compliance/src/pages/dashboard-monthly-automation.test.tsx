// @vitest-environment jsdom
// The month-end close card's monthly-automation strip — specifically the
// "Run month-end close monthly" consent dialog and its evidence line
// (Prove with Clerk phase 2). The pins that matter:
//  - The dialog leads with the client's OWN backtest (text-plan-evidence),
//    rendered ABOVE the consent copy, phrased by the shared planEvidenceLine.
//  - Honest copy: no evidence, or every plan kind with an empty sample,
//    renders NOTHING — no placeholder — and never blocks granting.
//  - Granting sends the month_end_close template for this client either way.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AutomationEvidence,
  AutomationEvidenceKind,
} from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the strip renders with
// (the dashboard-clerk-actions harness pattern).
const harness = vi.hoisted(() => ({
  planPolicies: {
    data: undefined as unknown,
  },
  evidence: {
    data: undefined as unknown,
  },
  policyCalls: {
    grant: [] as unknown[],
    pause: [] as unknown[],
    resume: [] as unknown[],
    revoke: [] as unknown[],
  },
  reset() {
    this.planPolicies.data = undefined;
    this.evidence.data = undefined;
    this.policyCalls.grant = [];
    this.policyCalls.pause = [];
    this.policyCalls.resume = [];
    this.policyCalls.revoke = [];
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  type MutationOpts = {
    mutation?: { onSuccess?: () => void; onError?: (e: unknown) => void };
  };
  const policyMutation =
    (name: keyof typeof harness.policyCalls) => (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown, callOpts?: { onSuccess?: () => void }) => {
        harness.policyCalls[name].push(vars);
        options?.mutation?.onSuccess?.();
        callOpts?.onSuccess?.();
      },
    });
  return {
    ...actual,
    useGetPlanPolicies: () => ({
      data: harness.planPolicies.data,
    }),
    useGetClientAutomationEvidence: () => ({
      data: harness.evidence.data,
    }),
    useGrantPlanPolicy: policyMutation("grant"),
    usePausePlanPolicy: policyMutation("pause"),
    useResumePlanPolicy: policyMutation("resume"),
    useRevokePlanPolicy: policyMutation("revoke"),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { MonthlyAutomationStrip } from "./dashboard";
import { planEvidenceLine } from "@/lib/format";

function evidenceKind(
  over: Partial<AutomationEvidenceKind> = {},
): AutomationEvidenceKind {
  return {
    kind: "submit_overdue",
    sample: 12,
    agreed: 9,
    disagreed: 1,
    pending: 2,
    agreementRate: 0.75,
    medianLeadDays: 4,
    exposureFloorNgn: null,
    note: "Backtested against your own submissions.",
    ...over,
  };
}

function evidence(kinds: AutomationEvidenceKind[]): AutomationEvidence {
  return { windowMonths: 6, asOf: "2026-08-06", kinds };
}

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  return render(
    <QueryClientProvider client={qc}>
      <MonthlyAutomationStrip clientPartyId="cp-1" />
    </QueryClientProvider>,
  );
}

const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
  // Flag lit, no grant yet: the strip offers "Run monthly".
  harness.planPolicies.data = { policies: [], enabled: true };
});

describe("MonthlyAutomationStrip (consent dialog evidence)", () => {
  test("the consent dialog leads with the client's own record, above the consent copy", async () => {
    harness.evidence.data = evidence([
      // reconcile_matches is not a plan step — it must not phrase a segment.
      evidenceKind({ kind: "reconcile_matches", sample: 40, agreed: 38 }),
      evidenceKind(),
      evidenceKind({ kind: "retry_failed", sample: 5, agreed: 3, medianLeadDays: 2 }),
      evidenceKind({ kind: "draft_recurring", sample: 3, agreed: 2, medianLeadDays: 6 }),
    ]);
    renderStrip();
    await click(screen.getByTestId("button-plan-policy-grant"));

    const line = screen.getByTestId("text-plan-evidence");
    expect(line.textContent).toBe(
      planEvidenceLine([
        { kind: "submit_overdue", sample: 12, agreed: 9, medianLeadDays: 4 },
        { kind: "retry_failed", sample: 5, agreed: 3, medianLeadDays: 2 },
        { kind: "draft_recurring", sample: 3, agreed: 2, medianLeadDays: 6 },
      ]),
    );
    // ABOVE the consent sentence, so the record is read before the grant.
    const description = screen.getByText(
      /Each month, Clerk will run this close plan for your business/,
    );
    expect(
      line.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Advisory only: the evidence never gates the confirm button.
    expect(
      (screen.getByTestId("button-confirm-plan-policy") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  test("no evidence or all-empty samples renders no line — and never blocks granting", async () => {
    // No evidence at all (failed fetch, older server): nothing renders and
    // the grant still goes through.
    renderStrip();
    await click(screen.getByTestId("button-plan-policy-grant"));
    expect(screen.queryByTestId("text-plan-evidence")).toBeNull();
    await click(screen.getByTestId("button-confirm-plan-policy"));
    expect(harness.policyCalls.grant).toEqual([
      { data: { templateKey: "month_end_close", clientPartyId: "cp-1" } },
    ]);
    cleanup();

    // Every plan kind with an empty sample: no rate from nothing.
    harness.evidence.data = evidence([
      evidenceKind({ sample: 0, agreed: 0, agreementRate: null, medianLeadDays: null }),
      evidenceKind({
        kind: "retry_failed",
        sample: 0,
        agreed: 0,
        agreementRate: null,
        medianLeadDays: null,
      }),
    ]);
    renderStrip();
    await click(screen.getByTestId("button-plan-policy-grant"));
    expect(screen.queryByTestId("text-plan-evidence")).toBeNull();
    expect(
      (screen.getByTestId("button-confirm-plan-policy") as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});
