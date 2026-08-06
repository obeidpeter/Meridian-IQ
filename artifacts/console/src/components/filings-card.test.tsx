// @vitest-environment jsdom
// The client page's "Filings register" card (Filing Desk). The pins:
//  - Overdue = not yet FILED past the due date (a filed row never is; a
//    prepared one still is — preparation is firm work, filing is what the
//    deadline wants), and the pill words come from the shared filing-copy
//    vocabulary with an "Overdue" red override.
//  - "Sync register" mints the period's rows server-side and invalidates the
//    filings list by its real generated query key, so all filtered variants
//    (including the SME app's twin) go stale together — as does every
//    status walk.
//  - The prepared → filed walk: "Mark prepared" sends the bare move; "Mark
//    filed" opens one inline evidence panel (filed date defaults to today,
//    reference optional and OMITTED when empty — never "").
//  - Actions gate on the filing.write capability: a read-only viewer sees
//    the register and its pills but no buttons that could only ever 403.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Filing } from "@workspace/api-client-react";

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
  sync: {
    calls: 0,
    result: null as unknown,
  },
  status: {
    calls: [] as unknown[],
    result: null as unknown,
  },
  capabilities: [] as string[],
  reset() {
    this.list.data = undefined;
    this.list.isLoading = false;
    this.list.error = null;
    this.list.refetchCalls = 0;
    this.sync.calls = 0;
    this.sync.result = null;
    this.status.calls = [];
    this.status.result = null;
    this.capabilities = ["filing.read", "filing.write"];
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
    useGetMe: () => ({ data: { capabilities: harness.capabilities } }),
    useListFilings: () => ({
      data: harness.list.data,
      isLoading: harness.list.isLoading,
      error: harness.list.error,
      refetch: () => {
        harness.list.refetchCalls += 1;
      },
    }),
    useSyncFilings: (options?: MutationOpts) => ({
      isPending: false,
      mutate: () => {
        harness.sync.calls += 1;
        options?.mutation?.onSuccess?.(harness.sync.result, undefined);
      },
    }),
    useUpdateFilingStatus: (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        harness.status.calls.push(vars);
        options?.mutation?.onSuccess?.(harness.status.result, vars);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import { FilingsCard, filingOverdue, filingPill } from "./filings-card";
import { getListFilingsQueryKey } from "@workspace/api-client-react";
import { localDayIso } from "@workspace/format/notice-copy";

function filing(over: Partial<Filing> = {}): Filing {
  return {
    id: "fil-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    taxType: "vat",
    period: "2026-07",
    // Far future by default so rows are never overdue by accident — the
    // card compares against the REAL clock's calendar day.
    dueDate: "2999-01-21",
    status: "upcoming",
    filedDate: null,
    filedReference: null,
    notes: null,
    preparedBy: null,
    filedBy: null,
    createdAt: "2026-08-01T10:00:00Z",
    updatedAt: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={qc}>
      <FilingsCard clientPartyId="cp-1" />
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
  harness.list.data = { filings: [] };
});

// ---- Pure helpers -----------------------------------------------------------

describe("filings-card helpers", () => {
  test("overdue = not yet FILED past the due date; filed is never overdue", () => {
    expect(
      filingOverdue({ status: "upcoming", dueDate: "2026-07-21" }, "2026-08-01"),
    ).toBe(true);
    // Prepared still counts — the deadline wants the filing, not the prep.
    expect(
      filingOverdue({ status: "prepared", dueDate: "2026-07-21" }, "2026-08-01"),
    ).toBe(true);
    // Due today is not overdue yet.
    expect(
      filingOverdue({ status: "upcoming", dueDate: "2026-08-01" }, "2026-08-01"),
    ).toBe(false);
    expect(
      filingOverdue({ status: "filed", dueDate: "2026-07-21" }, "2026-08-01"),
    ).toBe(false);
  });

  test("the pill: shared words, console-local tones, red Overdue override", () => {
    expect(filingPill({ status: "upcoming" }, false)).toEqual({
      tone: "slate",
      label: "Upcoming",
    });
    expect(filingPill({ status: "prepared" }, false)).toEqual({
      tone: "blue",
      label: "Prepared",
    });
    expect(filingPill({ status: "filed" }, false)).toEqual({
      tone: "emerald",
      label: "Filed",
    });
    expect(filingPill({ status: "upcoming" }, true)).toEqual({
      tone: "red",
      label: "Overdue",
    });
    // An off-catalogue status from a newer server degrades to slate + a
    // title-cased word, never a crash.
    expect(filingPill({ status: "in_review" as Filing["status"] }, false)).toEqual({
      tone: "slate",
      label: "In review",
    });
  });
});

// ---- The card ---------------------------------------------------------------

describe("FilingsCard", () => {
  test("empty register: the empty line, the sync button and the evidence-only foot", () => {
    renderCard();
    expect(screen.getByTestId("card-filings")).toBeTruthy();
    expect(screen.getByTestId("text-filings-empty")).toBeTruthy();
    expect(screen.getByTestId("button-sync-filings")).toBeTruthy();
    expect(screen.getByTestId("card-filings").textContent).toContain(
      "the platform never files anything itself",
    );
  });

  test("loading shows the skeleton; a failed list shows the retryable error state", async () => {
    harness.list.isLoading = true;
    renderCard();
    expect(screen.getByTestId("skeleton-filings")).toBeTruthy();
    cleanup();

    harness.list.isLoading = false;
    harness.list.error = new Error("boom");
    renderCard();
    expect(screen.getByTestId("text-error").textContent).toContain(
      "the filings register",
    );
    await click(screen.getByText("Try again"));
    expect(harness.list.refetchCalls).toBe(1);
  });

  test("Sync register mints server-side and refetches the list by its real key", async () => {
    harness.sync.result = { minted: 2 };
    const { invalidatedKeys } = renderCard();

    await click(screen.getByTestId("button-sync-filings"));
    expect(harness.sync.calls).toBe(1);
    expect(invalidatedKeys()).toContainEqual(getListFilingsQueryKey());
  });

  test("rows render the shared vocabulary, due date and filed evidence", () => {
    harness.list.data = {
      filings: [
        filing({ id: "vat-1" }),
        filing({
          id: "paye-1",
          taxType: "paye",
          status: "filed",
          filedDate: "2026-08-05",
          filedReference: "FIRS/PAYE/77",
        }),
      ],
    };
    renderCard();

    // Vocabulary labels, never raw enums: the KIND is the return's name
    // ("VAT return", not "VAT") and the period reads as a month.
    const vatRow = screen.getByTestId("row-filing-vat-1");
    expect(vatRow.textContent).toContain("VAT return · July 2026");
    expect(vatRow.textContent).toContain("Due");
    expect(screen.getByTestId("pill-filing-vat-1").textContent).toBe(
      "Upcoming",
    );

    const payeRow = screen.getByTestId("row-filing-paye-1");
    expect(payeRow.textContent).toContain("PAYE remittance · July 2026");
    expect(payeRow.textContent).toContain("Ref FIRS/PAYE/77");
    expect(screen.getByTestId("pill-filing-paye-1").textContent).toBe("Filed");
    // Filed is terminal — no further actions on the row.
    expect(screen.queryByTestId("button-filing-prepared-paye-1")).toBeNull();
    expect(screen.queryByTestId("button-filing-filed-paye-1")).toBeNull();
  });

  test("an unfiled row past its due date is flagged overdue; a filed one is not", () => {
    harness.list.data = {
      filings: [
        filing({ id: "late", dueDate: "2000-01-21" }),
        filing({
          id: "done",
          status: "filed",
          dueDate: "2000-01-21",
          filedDate: "2000-02-01",
        }),
      ],
    };
    renderCard();
    expect(screen.getByTestId("pill-filing-late").textContent).toBe("Overdue");
    expect(screen.getByTestId("pill-filing-late").className).toContain("red");
    expect(screen.getByTestId("row-filing-late").className).toContain(
      "border-red-300",
    );
    expect(screen.getByTestId("pill-filing-done").textContent).toBe("Filed");
  });

  test("Mark prepared sends the bare move and refetches by the real key", async () => {
    harness.list.data = { filings: [filing({ id: "fil-9" })] };
    harness.status.result = filing({ id: "fil-9", status: "prepared" });
    const { invalidatedKeys } = renderCard();

    await click(screen.getByTestId("button-filing-prepared-fil-9"));
    expect(harness.status.calls).toEqual([
      { id: "fil-9", data: { status: "prepared" } },
    ]);
    expect(invalidatedKeys()).toContainEqual(getListFilingsQueryKey());
  });

  test("the filed walk: panel defaults today, sends date + trimmed reference", async () => {
    harness.list.data = {
      filings: [filing({ id: "fil-9", status: "prepared" })],
    };
    harness.status.result = filing({ id: "fil-9", status: "filed" });
    renderCard();

    // A prepared row offers only the filed move.
    expect(screen.queryByTestId("button-filing-prepared-fil-9")).toBeNull();
    // Nothing expanded by default; the toggle opens and closes the panel.
    expect(screen.queryByTestId("panel-filing-filed-fil-9")).toBeNull();
    await click(screen.getByTestId("button-filing-filed-fil-9"));
    expect(screen.getByTestId("panel-filing-filed-fil-9")).toBeTruthy();

    const today = localDayIso(new Date());
    const dateInput = screen.getByTestId(
      "input-filing-filed-date-fil-9",
    ) as HTMLInputElement;
    expect(dateInput.value).toBe(today);

    fireEvent.change(screen.getByTestId("input-filing-reference-fil-9"), {
      target: { value: "  FIRS/VAT/2026/07  " },
    });
    await click(screen.getByTestId("button-filing-filed-confirm-fil-9"));
    expect(harness.status.calls).toEqual([
      {
        id: "fil-9",
        data: {
          status: "filed",
          filedDate: today,
          filedReference: "FIRS/VAT/2026/07",
        },
      },
    ]);
  });

  test("an empty reference is OMITTED from the filed payload, never sent as \"\"", async () => {
    harness.list.data = {
      filings: [filing({ id: "fil-9", status: "prepared" })],
    };
    harness.status.result = filing({ id: "fil-9", status: "filed" });
    renderCard();

    await click(screen.getByTestId("button-filing-filed-fil-9"));

    // Clearing the date holds the confirm — "filed" requires filedDate —
    // and clicking sends nothing.
    fireEvent.change(screen.getByTestId("input-filing-filed-date-fil-9"), {
      target: { value: "" },
    });
    const confirm = screen.getByTestId(
      "button-filing-filed-confirm-fil-9",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await click(confirm);
    expect(harness.status.calls).toEqual([]);

    // Date restored, reference left blank: the payload carries no
    // filedReference key at all (a success closes the panel, so this is the
    // test's last act).
    const today = localDayIso(new Date());
    fireEvent.change(screen.getByTestId("input-filing-filed-date-fil-9"), {
      target: { value: today },
    });
    await click(screen.getByTestId("button-filing-filed-confirm-fil-9"));
    const sent = harness.status.calls[0] as {
      data: Record<string, unknown>;
    };
    expect(sent.data.status).toBe("filed");
    expect(sent.data.filedDate).toBe(today);
    expect("filedReference" in sent.data).toBe(false);
    expect(screen.queryByTestId("panel-filing-filed-fil-9")).toBeNull();
  });

  test("without filing.write the register is read-only: pills, no buttons", () => {
    harness.capabilities = ["filing.read"];
    harness.list.data = { filings: [filing({ id: "fil-1" })] };
    renderCard();

    expect(screen.getByTestId("pill-filing-fil-1").textContent).toBe(
      "Upcoming",
    );
    expect(screen.queryByTestId("button-sync-filings")).toBeNull();
    expect(screen.queryByTestId("button-filing-prepared-fil-1")).toBeNull();
    expect(screen.queryByTestId("button-filing-filed-fil-1")).toBeNull();
  });
});
