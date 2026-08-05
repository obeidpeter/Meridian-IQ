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
//  - Response Desk: an OPEN row expands one inline panel at a time with the
//    two response tools — the bundle PDF goes through the generated URL
//    builder + the named-download helper, and the drafted letter renders
//    read-only with a source-honest provenance line (clerk vs template) and
//    a clipboard Copy. The platform never sends or files anything.
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
  respond: {
    calls: [] as unknown[],
    result: null as unknown,
    error: null as unknown,
    isPending: false,
  },
  downloads: [] as [string, string][],
  reset() {
    this.list.data = undefined;
    this.list.isLoading = false;
    this.list.error = null;
    this.list.refetchCalls = 0;
    this.create.calls = [];
    this.create.result = null;
    this.status.calls = [];
    this.status.result = null;
    this.respond.calls = [];
    this.respond.result = null;
    this.respond.error = null;
    this.respond.isPending = false;
    this.downloads = [];
  },
}));

// The named-download helper is a browser navigation — record it instead.
vi.mock("@/lib/download", () => ({
  triggerDownload: (url: string, filename: string) => {
    harness.downloads.push([url, filename]);
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
    useDraftObligationResponse: (options?: MutationOpts) => ({
      isPending: harness.respond.isPending,
      mutate: (vars: unknown) => {
        harness.respond.calls.push(vars);
        if (harness.respond.error) {
          options?.mutation?.onError?.(harness.respond.error);
        } else {
          options?.mutation?.onSuccess?.(harness.respond.result, vars);
        }
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
  responsePackFilename,
  todayIso,
} from "./obligations-card";
import {
  getGetObligationResponsePackUrl,
  getListObligationsQueryKey,
} from "@workspace/api-client-react";
import type { ObligationResponseDraft } from "@workspace/api-client-react";

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

function responseDraft(
  over: Partial<ObligationResponseDraft> = {},
): ObligationResponseDraft {
  return {
    obligationId: "obl-1",
    letter: "Dear Sir/Madam,\n\nWe write in response to your notice.",
    source: "clerk",
    monthStart: "2026-07-01",
    monthLabel: "July 2026",
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

  test("responsePackFilename: sanitized reference, else id prefix", () => {
    // Reference slugged filename-safe: lowercased, runs of non-alphanumerics
    // collapse to one dash, edges trimmed.
    expect(
      responsePackFilename({ id: "obl-1", reference: "FIRS/2026/0042" }),
    ).toBe("response-pack-firs-2026-0042.pdf");
    expect(
      responsePackFilename({ id: "obl-1", reference: "  LIRS //  7 " }),
    ).toBe("response-pack-lirs-7.pdf");
    // No reference (or nothing usable in it): the obligation id's prefix.
    expect(
      responsePackFilename({ id: "0123456789abcdef", reference: null }),
    ).toBe("response-pack-01234567.pdf");
    expect(responsePackFilename({ id: "short", reference: "///" })).toBe(
      "response-pack-short.pdf",
    );
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
    // The status words come from the shared notice-copy vocabulary — an open
    // obligation reads "Awaiting response" in every app.
    expect(screen.getByTestId("pill-obligation-soon").textContent).toBe(
      "Awaiting response",
    );
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

// ---- Response Desk ----------------------------------------------------------

describe("ObligationsCard response desk", () => {
  test("only OPEN rows offer Prepare response; one panel open at a time", async () => {
    harness.list.data = {
      obligations: [
        obligation({ id: "a" }),
        obligation({ id: "b", responseDueDate: "2999-02-01" }),
        obligation({
          id: "answered",
          status: "responded",
          responseDueDate: "2999-03-01",
        }),
      ],
    };
    renderCard();

    // Responded rows keep their lifecycle actions but never the response
    // tools; closed rows are not rendered at all (worklist).
    expect(
      screen.queryByTestId("button-obligation-respond-answered"),
    ).toBeNull();

    // Nothing expanded by default.
    expect(screen.queryByTestId("panel-obligation-respond-a")).toBeNull();

    await click(screen.getByTestId("button-obligation-respond-a"));
    expect(screen.getByTestId("panel-obligation-respond-a")).toBeTruthy();
    expect(screen.queryByTestId("panel-obligation-respond-b")).toBeNull();
    // The covenant rides the panel.
    expect(
      screen.getByTestId("panel-obligation-respond-a").textContent,
    ).toContain(
      "The platform never sends or files the response — this is a draft for the firm to own.",
    );

    // Opening another row's panel closes the first.
    await click(screen.getByTestId("button-obligation-respond-b"));
    expect(screen.queryByTestId("panel-obligation-respond-a")).toBeNull();
    expect(screen.getByTestId("panel-obligation-respond-b")).toBeTruthy();

    // Clicking the open row's action again collapses it.
    await click(screen.getByTestId("button-obligation-respond-b"));
    expect(screen.queryByTestId("panel-obligation-respond-b")).toBeNull();
  });

  test("the bundle download rides the generated URL + the sanitized filename", async () => {
    harness.list.data = {
      obligations: [obligation({ id: "obl-7", reference: "FIRS/2026/0042" })],
    };
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-7"));
    await click(screen.getByTestId("button-response-pack-obl-7"));

    expect(harness.downloads).toEqual([
      [
        getGetObligationResponsePackUrl({ obligationId: "obl-7" }),
        "response-pack-firs-2026-0042.pdf",
      ],
    ]);
    // The builder really is the pack endpoint with the row pinned.
    expect(harness.downloads[0][0]).toContain("/api/obligation-response-pack");
    expect(harness.downloads[0][0]).toContain("obligationId=obl-7");
  });

  test("drafting sends an empty body and renders the letter with clerk provenance", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-1" })] };
    harness.respond.result = responseDraft({
      letter: "Dear Sir,\n\nRe: FIRS/2026/0042.",
      source: "clerk",
      monthLabel: "July 2026",
    });
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-1"));
    // No letter until the partner asks for one.
    expect(screen.queryByTestId("text-response-letter-obl-1")).toBeNull();

    await click(screen.getByTestId("button-response-draft-obl-1"));
    // Empty body — the server defaults the month to the notice's issue month.
    expect(harness.respond.calls).toEqual([{ id: "obl-1", data: {} }]);

    const letterEl = screen.getByTestId(
      "text-response-letter-obl-1",
    ) as HTMLTextAreaElement;
    expect(letterEl.value).toBe("Dear Sir,\n\nRe: FIRS/2026/0042.");
    expect(letterEl.readOnly).toBe(true);

    const provenance = screen.getByTestId(
      "text-response-provenance-obl-1",
    ).textContent;
    expect(provenance).toContain("July 2026");
    expect(provenance).toContain(
      "Drafted by Clerk from the period's records — review and edit before sending.",
    );
  });

  test("a template draft says so — the panel never dresses the fallback up as Clerk", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-1" })] };
    harness.respond.result = responseDraft({
      source: "template",
      monthLabel: "June 2026",
    });
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-1"));
    await click(screen.getByTestId("button-response-draft-obl-1"));

    const provenance = screen.getByTestId(
      "text-response-provenance-obl-1",
    ).textContent;
    expect(provenance).toContain("June 2026");
    expect(provenance).toContain(
      "Assembled from the period's records (Clerk unavailable) — review and edit before sending.",
    );
    expect(provenance).not.toContain("Drafted by Clerk");
  });

  test("a failed draft renders no letter", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-1" })] };
    harness.respond.error = new Error("boom");
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-1"));
    await click(screen.getByTestId("button-response-draft-obl-1"));
    expect(screen.queryByTestId("text-response-letter-obl-1")).toBeNull();
  });

  test("Copy letter writes the letter body to the clipboard", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-1" })] };
    harness.respond.result = responseDraft({ letter: "Dear Sir,\n\nBody." });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-1"));
    await click(screen.getByTestId("button-response-draft-obl-1"));
    await click(screen.getByTestId("button-copy-letter-obl-1"));
    expect(writeText).toHaveBeenCalledWith("Dear Sir,\n\nBody.");
  });

  test("the draft button shows its pending state", async () => {
    harness.list.data = { obligations: [obligation({ id: "obl-1" })] };
    harness.respond.isPending = true;
    renderCard();

    await click(screen.getByTestId("button-obligation-respond-obl-1"));
    const draftBtn = screen.getByTestId(
      "button-response-draft-obl-1",
    ) as HTMLButtonElement;
    expect(draftBtn.disabled).toBe(true);
    expect(draftBtn.textContent).toContain("Drafting…");
  });
});
