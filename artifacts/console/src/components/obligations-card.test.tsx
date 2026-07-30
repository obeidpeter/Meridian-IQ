// @vitest-environment jsdom
// The client page's "Authority notices" card (Notice Desk). The pins:
//  - The list is a WORKLIST: closed obligations drop off, the rest order by
//    soonest response deadline, and an open row past its deadline is
//    visually flagged overdue (a responded row never is).
//  - The inline "Record notice" form is gated exactly on the contract's
//    required trio (noticeType, authority, responseDueDate) plus the
//    client pin the card carries; optional empties are OMITTED from the
//    payload, never sent as "".
//  - Every write invalidates the obligations list by its real generated
//    query key, so all filtered variants go stale together.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Obligation } from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the card renders with. The
// rest of the module stays real — in particular the query-key builders, so
// the invalidation assertions compare against genuine keys.
const harness = vi.hoisted(() => ({
  list: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
    refetchCalls: 0,
  },
  create: {
    calls: [] as unknown[],
    result: null as unknown,
  },
  status: {
    calls: [] as unknown[],
    result: null as unknown,
  },
  reset() {
    this.list.data = undefined;
    this.list.isLoading = false;
    this.list.error = null;
    this.list.refetchCalls = 0;
    this.create.calls = [];
    this.create.result = null;
    this.status.calls = [];
    this.status.result = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  type MutationOpts = {
    mutation?: {
      onSuccess?: (data: unknown, vars: unknown) => void;
      onError?: (e: unknown) => void;
    };
  };
  return {
    ...actual,
    useListObligations: () => ({
      data: harness.list.data,
      isLoading: harness.list.isLoading,
      error: harness.list.error,
      refetch: () => {
        harness.list.refetchCalls += 1;
      },
    }),
    useCreateObligation: (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        harness.create.calls.push(vars);
        options?.mutation?.onSuccess?.(harness.create.result, vars);
      },
    }),
    useUpdateObligationStatus: (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        harness.status.calls.push(vars);
        options?.mutation?.onSuccess?.(harness.status.result, vars);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import {
  EMPTY_OBLIGATION_DRAFT,
  ObligationsCard,
  obligationDraftIncomplete,
  obligationInputFromDraft,
  obligationOverdue,
  openObligationRows,
  todayIso,
} from "./obligations-card";
import { getListObligationsQueryKey } from "@workspace/api-client-react";

function obligation(over: Partial<Obligation> = {}): Obligation {
  return {
    id: "obl-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    sourceCaseId: null,
    noticeType: "assessment",
    authority: "firs",
    reference: "FIRS/2026/0042",
    taxType: "vat",
    period: null,
    amount: "150000.00",
    currency: "NGN",
    issueDate: "2026-07-01",
    // Far future by default so rows are never overdue by accident — the
    // card compares against the REAL clock's calendar day.
    responseDueDate: "2999-01-01",
    status: "open",
    notes: null,
    createdBy: "u-1",
    createdAt: "2026-07-20T10:00:00Z",
    updatedAt: "2026-07-20T10:00:00Z",
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={qc}>
      <ObligationsCard clientPartyId="cp-1" />
    </QueryClientProvider>,
  );
  return {
    invalidatedKeys: () =>
      spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey),
  };
}

const click = (el: Element) =>
  act(async () => {
    fireEvent.click(el);
  });

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
  harness.list.data = { obligations: [] };
});

// ---- Pure helpers -----------------------------------------------------------

describe("obligations-card helpers", () => {
  test("overdue = still OPEN past the deadline; responded is never overdue", () => {
    expect(
      obligationOverdue(
        { status: "open", responseDueDate: "2026-07-01" },
        "2026-07-30",
      ),
    ).toBe(true);
    // Due today is not overdue yet.
    expect(
      obligationOverdue(
        { status: "open", responseDueDate: "2026-07-30" },
        "2026-07-30",
      ),
    ).toBe(false);
    expect(
      obligationOverdue(
        { status: "responded", responseDueDate: "2026-07-01" },
        "2026-07-30",
      ),
    ).toBe(false);
  });

  test("todayIso renders the local calendar day as YYYY-MM-DD", () => {
    expect(todayIso(new Date(2026, 6, 30, 23, 59))).toBe("2026-07-30");
    expect(todayIso(new Date(2026, 0, 5, 0, 1))).toBe("2026-01-05");
  });

  test("rows: closed drop off, the rest order by soonest deadline", () => {
    const rows = openObligationRows([
      obligation({ id: "later", responseDueDate: "2026-09-01" }),
      obligation({
        id: "gone",
        status: "closed",
        responseDueDate: "2026-01-01",
      }),
      obligation({ id: "soon", responseDueDate: "2026-08-01" }),
      obligation({
        id: "answered",
        status: "responded",
        responseDueDate: "2026-08-15",
      }),
    ]);
    expect(rows.map((o) => o.id)).toEqual(["soon", "answered", "later"]);
    expect(openObligationRows(undefined)).toEqual([]);
  });

  test("the draft gate: required trio only, optionals never gate", () => {
    const ready = {
      ...EMPTY_OBLIGATION_DRAFT,
      noticeType: "demand" as const,
      authority: "firs" as const,
      responseDueDate: "2026-08-15",
    };
    expect(obligationDraftIncomplete(ready)).toBe(false);
    expect(obligationDraftIncomplete(EMPTY_OBLIGATION_DRAFT)).toBe(true);
    expect(obligationDraftIncomplete({ ...ready, noticeType: "" })).toBe(true);
    expect(obligationDraftIncomplete({ ...ready, authority: "" })).toBe(true);
    expect(
      obligationDraftIncomplete({ ...ready, responseDueDate: "" }),
    ).toBe(true);
  });

  test("draft -> payload: client pinned, optionals trimmed or OMITTED", () => {
    expect(
      obligationInputFromDraft("cp-1", {
        noticeType: "demand",
        authority: "state_irs",
        taxType: "paye",
        reference: "  LIRS/11  ",
        amount: "25000",
        issueDate: "2026-07-10",
        responseDueDate: "2026-08-15",
      }),
    ).toEqual({
      clientPartyId: "cp-1",
      noticeType: "demand",
      authority: "state_irs",
      responseDueDate: "2026-08-15",
      taxType: "paye",
      reference: "LIRS/11",
      amount: "25000",
      issueDate: "2026-07-10",
    });

    const minimal = obligationInputFromDraft("cp-1", {
      ...EMPTY_OBLIGATION_DRAFT,
      noticeType: "demand",
      authority: "firs",
      responseDueDate: "2026-08-15",
    });
    expect(minimal).toEqual({
      clientPartyId: "cp-1",
      noticeType: "demand",
      authority: "firs",
      responseDueDate: "2026-08-15",
    });
    expect("reference" in minimal).toBe(false);
    expect("taxType" in minimal).toBe(false);
  });
});

// ---- The card ---------------------------------------------------------------

describe("ObligationsCard", () => {
  test("empty list: the card stays up with the empty line and the recorder", () => {
    renderCard();
    expect(screen.getByTestId("card-obligations")).toBeTruthy();
    expect(screen.getByTestId("text-obligations-empty")).toBeTruthy();
    expect(screen.getByTestId("button-record-notice")).toBeTruthy();
  });

  test("loading shows the skeleton; a failed list shows the retryable error state", async () => {
    harness.list.isLoading = true;
    renderCard();
    expect(screen.getByTestId("skeleton-obligations")).toBeTruthy();
    cleanup();

    harness.list.isLoading = false;
    harness.list.error = new Error("boom");
    renderCard();
    expect(screen.getByTestId("text-error").textContent).toContain(
      "authority notices",
    );
    await click(screen.getByText("Try again"));
    expect(harness.list.refetchCalls).toBe(1);
  });

  test("rows render soonest-first with labels, reference and deadline; closed rows drop off", () => {
    harness.list.data = {
      obligations: [
        obligation({ id: "later", responseDueDate: "2999-09-01" }),
        obligation({
          id: "soon",
          noticeType: "information_request",
          authority: "state_irs",
          reference: "LIRS/7",
          amount: null,
          responseDueDate: "2999-01-01",
        }),
        obligation({ id: "gone", status: "closed" }),
      ],
    };
    renderCard();
    const rows = screen.getAllByTestId(/^row-obligation-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "row-obligation-soon",
      "row-obligation-later",
    ]);
    // Vocabulary labels, never raw enums.
    expect(screen.getByTestId("row-obligation-soon").textContent).toContain(
      "Information request · State IRS",
    );
    expect(screen.getByTestId("row-obligation-soon").textContent).toContain(
      "Ref LIRS/7",
    );
    expect(screen.getByTestId("pill-obligation-soon").textContent).toBe("Open");
  });

  test("an open row past its deadline is flagged overdue; a responded one is not", () => {
    harness.list.data = {
      obligations: [
        obligation({ id: "late", responseDueDate: "2000-01-01" }),
        obligation({
          id: "answered",
          status: "responded",
          responseDueDate: "2000-01-02",
        }),
      ],
    };
    renderCard();
    expect(screen.getByTestId("pill-obligation-late").textContent).toBe(
      "Overdue",
    );
    expect(
      screen.getByTestId("pill-obligation-late").className,
    ).toContain("red");
    expect(
      screen.getByTestId("row-obligation-late").className,
    ).toContain("border-red-300");
    expect(screen.getByTestId("pill-obligation-answered").textContent).toBe(
      "Responded",
    );
    // A responded obligation only awaits closure — no "Mark responded".
    expect(
      screen.queryByTestId("button-obligation-responded-answered"),
    ).toBeNull();
    expect(
      screen.getByTestId("button-obligation-close-answered"),
    ).toBeTruthy();
  });

  test("status actions send the lifecycle move and refetch the list by its real key", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-9" })] };
    harness.status.result = obligation({ id: "obl-9", status: "responded" });
    const { invalidatedKeys } = renderCard();

    await click(screen.getByTestId("button-obligation-responded-obl-9"));
    expect(harness.status.calls).toEqual([
      { id: "obl-9", data: { status: "responded" } },
    ]);
    expect(invalidatedKeys()).toContainEqual(getListObligationsQueryKey());

    harness.status.result = obligation({ id: "obl-9", status: "closed" });
    await click(screen.getByTestId("button-obligation-close-obl-9"));
    expect(harness.status.calls).toEqual([
      { id: "obl-9", data: { status: "responded" } },
      { id: "obl-9", data: { status: "closed" } },
    ]);
  });

  test("the recorder opens on demand and holds Record until the required trio is set", async () => {
    renderCard();
    // Closed by default.
    expect(screen.queryByTestId("button-create-obligation")).toBeNull();

    await click(screen.getByTestId("button-record-notice"));
    const submit = screen.getByTestId(
      "button-create-obligation",
    ) as HTMLButtonElement;
    // Empty draft: the required trio is missing, Record stays disabled and
    // clicking sends nothing.
    expect(submit.disabled).toBe(true);
    await click(submit);
    expect(harness.create.calls).toEqual([]);

    // The free-text inputs alone never satisfy the gate — the closed
    // catalogues (selects) are required.
    fireEvent.change(screen.getByTestId("input-obligation-due-date"), {
      target: { value: "2999-02-01" },
    });
    fireEvent.change(screen.getByTestId("input-obligation-reference"), {
      target: { value: "FIRS/9" },
    });
    expect(
      (screen.getByTestId("button-create-obligation") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
