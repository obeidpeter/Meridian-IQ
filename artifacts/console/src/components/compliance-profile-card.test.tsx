// @vitest-environment jsdom
// The client page's "Statutory profile" card (Compliance Profile round). The
// pins:
//  - The UNASSERTED state renders (unlike the empty-book null-render cards —
//    absence is the story here): an explainer plus the "Assert profile"
//    affordance opening the form.
//  - Nothing is pre-selected on a first assert beyond the contract's false
//    defaults; optionals travel as null, never "" — and the notes are
//    trimmed. A save invalidates the profile query by its real generated key
//    (plus the firm summary the portfolio checklist reads) and closes the
//    form.
//  - The asserted facts line uses the fixed vocabulary ("VAT-registered:
//    Yes/No · PAYE employer: … · FYE: … · Incorporated: …") with "Not
//    captured" for a null FYE or incorporation date.
//  - The exposure strip renders only when overdue annual rows exist, in the
//    red tone, and always says "estimated" — never "penalty owed".
//  - Writes gate on the filing.write capability: a read-only viewer sees the
//    facts (or the explainer) but no buttons that could only ever 403.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComplianceProfile } from "@workspace/api-client-react";

// Controllable stand-ins for the generated hooks the card renders with. The
// rest of the module stays real — in particular the query-key builders, so
// the invalidation assertions compare against genuine keys.
const harness = vi.hoisted(() => ({
  profile: {
    data: undefined as unknown,
    isLoading: false,
    error: null as unknown,
  },
  exposure: {
    data: undefined as unknown,
  },
  update: {
    calls: [] as unknown[],
    result: null as unknown,
  },
  capabilities: [] as string[],
  reset() {
    this.profile.data = undefined;
    this.profile.isLoading = false;
    this.profile.error = null;
    this.exposure.data = undefined;
    this.update.calls = [];
    this.update.result = null;
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
    useGetComplianceProfile: () => ({
      data: harness.profile.data,
      isLoading: harness.profile.isLoading,
      error: harness.profile.error,
      refetch: () => {},
    }),
    useGetFilingPenaltyExposure: () => ({ data: harness.exposure.data }),
    useUpdateComplianceProfile: (options?: MutationOpts) => ({
      isPending: false,
      mutate: (vars: unknown) => {
        harness.update.calls.push(vars);
        options?.mutation?.onSuccess?.(harness.update.result, vars);
      },
    }),
  };
});

// Import AFTER the mock so the component module binds the stand-ins.
import {
  ComplianceProfileCard,
  fyeMonthLabel,
  profileFacts,
} from "./compliance-profile-card";
import {
  getGetComplianceProfileQueryKey,
  getGetComplianceProfileSummaryQueryKey,
} from "@workspace/api-client-react";

function profile(over: Partial<ComplianceProfile> = {}): ComplianceProfile {
  return {
    clientPartyId: "cp-1",
    vatRegistered: true,
    payeEmployer: false,
    fyeMonth: 3,
    incorporationDate: "2020-03-15",
    notes: null,
    updatedAt: "2026-08-01T10:00:00Z",
    ...over,
  };
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const spy = vi.spyOn(qc, "invalidateQueries").mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={qc}>
      <ComplianceProfileCard clientPartyId="cp-1" />
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
});

// ---- Pure helpers -----------------------------------------------------------

describe("fyeMonthLabel / profileFacts", () => {
  test("a captured month names itself; null (or off-range) reads Not captured", () => {
    expect(fyeMonthLabel(1)).toBe("January");
    expect(fyeMonthLabel(12)).toBe("December");
    expect(fyeMonthLabel(null)).toBe("Not captured");
    expect(fyeMonthLabel(13)).toBe("Not captured");
  });

  test("the facts line carries the fixed vocabulary, Not captured for nulls", () => {
    expect(
      profileFacts({
        vatRegistered: true,
        payeEmployer: false,
        fyeMonth: null,
        incorporationDate: null,
      }),
    ).toBe(
      "VAT-registered: Yes · PAYE employer: No · FYE: Not captured · Incorporated: Not captured",
    );
  });
});

// ---- The card ---------------------------------------------------------------

describe("ComplianceProfileCard", () => {
  test("the unasserted state RENDERS: explainer, assert affordance, evidence foot", () => {
    harness.profile.data = { profile: null };
    renderCard();

    expect(screen.getByTestId("card-compliance-profile")).toBeTruthy();
    expect(
      screen.getByTestId("text-profile-unasserted").textContent,
    ).toContain("VAT and PAYE returns are both tracked");
    expect(screen.getByTestId("button-profile-assert")).toBeTruthy();
    expect(screen.queryByTestId("text-profile-facts")).toBeNull();
    expect(screen.queryByTestId("text-profile-exposure")).toBeNull();
    expect(
      screen.getByTestId("card-compliance-profile").textContent,
    ).toContain("the platform never infers them");
  });

  test("the assert flow sends the full body (trimmed notes), invalidates by the real keys, closes", async () => {
    harness.profile.data = { profile: null };
    harness.update.result = profile({ vatRegistered: true, payeEmployer: true });
    const { invalidatedKeys } = renderCard();

    await click(screen.getByTestId("button-profile-assert"));
    await click(screen.getByTestId("input-profile-vat"));
    await click(screen.getByTestId("input-profile-paye"));
    fireEvent.change(screen.getByTestId("select-profile-fye"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByTestId("input-profile-incorporation"), {
      target: { value: "2020-03-15" },
    });
    fireEvent.change(screen.getByTestId("input-profile-notes"), {
      target: { value: "  Registered with FIRS  " },
    });
    await click(screen.getByTestId("button-profile-save"));

    expect(harness.update.calls).toEqual([
      {
        id: "cp-1",
        data: {
          vatRegistered: true,
          payeEmployer: true,
          fyeMonth: 12,
          incorporationDate: "2020-03-15",
          notes: "Registered with FIRS",
        },
      },
    ]);
    expect(invalidatedKeys()).toContainEqual(
      getGetComplianceProfileQueryKey("cp-1"),
    );
    expect(invalidatedKeys()).toContainEqual(
      getGetComplianceProfileSummaryQueryKey(),
    );
    // A success closes the form.
    expect(screen.queryByTestId("button-profile-save")).toBeNull();
  });

  test("a bare first assert sends the contract's false/null defaults — nothing pre-selected", async () => {
    harness.profile.data = { profile: null };
    harness.update.result = profile();
    renderCard();

    await click(screen.getByTestId("button-profile-assert"));
    await click(screen.getByTestId("button-profile-save"));

    expect(harness.update.calls).toEqual([
      {
        id: "cp-1",
        data: {
          vatRegistered: false,
          payeEmployer: false,
          fyeMonth: null,
          incorporationDate: null,
          notes: null,
        },
      },
    ]);
  });

  test("the asserted facts render, and the edit form seeds from them", async () => {
    harness.profile.data = { profile: profile() };
    renderCard();

    const facts = screen.getByTestId("text-profile-facts");
    expect(facts.textContent).toContain("VAT-registered: Yes");
    expect(facts.textContent).toContain("PAYE employer: No");
    expect(facts.textContent).toContain("FYE: March");
    expect(facts.textContent).toContain("Incorporated:");
    expect(screen.queryByTestId("text-profile-unasserted")).toBeNull();

    // Editing seeds from the asserted facts, not the blank defaults.
    await click(screen.getByTestId("button-profile-edit"));
    expect(
      screen.getByTestId("input-profile-vat").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      (screen.getByTestId("select-profile-fye") as HTMLSelectElement).value,
    ).toBe("3");
    expect(
      (screen.getByTestId("input-profile-incorporation") as HTMLInputElement)
        .value,
    ).toBe("2020-03-15");
  });

  test("a null FYE (and incorporation date) reads Not captured in the facts", () => {
    harness.profile.data = {
      profile: profile({ fyeMonth: null, incorporationDate: null }),
    };
    renderCard();

    const facts = screen.getByTestId("text-profile-facts");
    expect(facts.textContent).toContain("FYE: Not captured");
    expect(facts.textContent).toContain("Incorporated: Not captured");
  });

  test("overdue annual rows earn the red exposure strip — 'estimated', never 'owed'", () => {
    harness.profile.data = { profile: profile() };
    harness.exposure.data = {
      rows: [
        {
          taxType: "cit",
          period: "2025-12",
          dueDate: "2026-06-30",
          monthsLate: 2,
          exposureNgn: "100000.00",
        },
        {
          taxType: "paye_annual",
          period: "2025-12",
          dueDate: "2026-01-31",
          monthsLate: 7,
          exposureNgn: "25000.00",
        },
      ],
      totalNgn: "125000.00",
    };
    renderCard();

    const strip = screen.getByTestId("text-profile-exposure");
    expect(strip.textContent).toContain("Estimated late-filing exposure");
    expect(strip.textContent).toContain("125,000");
    expect(strip.textContent).toContain("2 overdue returns");
    expect(strip.textContent).not.toContain("owed");
    expect(strip.className).toContain("red");
  });

  test("a clean client hides the strip — totalNgn 0.00 with no rows", () => {
    harness.profile.data = { profile: profile() };
    harness.exposure.data = { rows: [], totalNgn: "0.00" };
    renderCard();

    expect(screen.queryByTestId("text-profile-exposure")).toBeNull();
  });

  test("without filing.write the card is read-only: facts, no assert/edit buttons", () => {
    harness.capabilities = ["filing.read"];
    harness.profile.data = { profile: null };
    renderCard();

    expect(screen.getByTestId("text-profile-unasserted")).toBeTruthy();
    expect(screen.queryByTestId("button-profile-assert")).toBeNull();
    expect(screen.queryByTestId("button-profile-edit")).toBeNull();
  });
});
