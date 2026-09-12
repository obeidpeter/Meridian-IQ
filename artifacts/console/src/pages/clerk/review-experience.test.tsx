// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type {
  ClerkCase,
  ClerkExtractionField,
  Firm,
  Party,
} from "@workspace/api-client-react";
import {
  approveDecisionFromForm,
  noticeDecisionFromForm,
  type ApproveForm,
  type NoticeApproveForm,
} from "@/pages/clerk-shared";
import { CaseDetail } from "./case-detail";
import { CaseSourcePanels } from "./case-source-panels";
import { ClaimControls } from "./claim-controls";
import { DocumentViewer } from "./document-viewer";
import { InvoiceApprovalSummary } from "./approval-summary";
import { InvoiceDecisionForm } from "./invoice-decision-form";
import { NoticeDecisionForm } from "./notice-decision-form";
import {
  approveDisabledFor,
  fieldsNeedingReview,
  reviewPaneFields,
} from "./review-derivations";
import type { ClerkWorkspaceState } from "./use-clerk-workspace";

const invoiceForm: ApproveForm = {
  firmId: "firm",
  supplierPartyId: "supplier",
  buyerPartyId: "buyer",
  invoiceNumber: "INV-7",
  issueDate: "2026-09-01",
  dueDate: "2026-09-30",
  currency: "NGN",
  category: "b2b",
  lines: [
    {
      description: "Review fixture",
      quantity: "2",
      unitPrice: "100",
      vatRate: "7.5",
    },
  ],
};
const noticeForm: NoticeApproveForm = {
  firmId: "firm",
  clientPartyId: "buyer",
  noticeType: "demand",
  authority: "firs",
  reference: "REF-7",
  taxType: "vat",
  period: "2026-Q3",
  amount: "100",
  currency: "NGN",
  issueDate: "2026-09-01",
  responseDueDate: "2026-09-30",
  notes: "",
};
const firms = [{ id: "firm", name: "Test firm" }] as Firm[];
const parties = [
  { id: "supplier", legalName: "Test supplier" },
  { id: "buyer", legalName: "Test customer" },
] as Party[];
const field = (
  patch: Partial<ClerkExtractionField> = {},
): ClerkExtractionField => ({
  field: "invoiceNumber",
  value: "INV-7",
  flagged: true,
  critical: true,
  confidence: 0.7,
  sourceSnippet: "Original invoice INV-7",
  ...patch,
});
const makeCase = (patch: Partial<ClerkCase> = {}): ClerkCase => ({
  id: "case-1",
  kind: "extraction",
  status: "extracted",
  createdBy: "operator",
  createdAt: "2026-09-01T12:00:00Z",
  updatedAt: "2026-09-01T12:00:00Z",
  sourceType: "text",
  sourceText: "Original invoice INV-7\nDo not rewrite this text.",
  preflight: [],
  extraction: {
    fields: [field()],
    lines: [],
    model: "fixture",
    promptVersion: "v1",
  },
  ...patch,
});
const mutation = () => ({ mutate: vi.fn(), isPending: false });
function makeState(
  selected: ClerkCase,
  patch: Partial<ClerkWorkspaceState> = {},
): ClerkWorkspaceState {
  return {
    selected,
    form: invoiceForm,
    noticeForm: null,
    reason: "",
    openSnippets: new Set(),
    imageOpen: true,
    pagesOpen: false,
    setImageOpen: vi.fn(),
    setPagesOpen: vi.fn(),
    setForm: vi.fn(),
    setNoticeForm: vi.fn(),
    setReason: vi.fn(),
    setOpenSnippets: vi.fn(),
    toggleSnippet: vi.fn(),
    setSelectedId: vi.fn(),
    decideCase: mutation(),
    decideNotice: mutation(),
    retryCase: mutation(),
    refetchSourcePages: vi.fn(),
    firms,
    parties,
    approveDisabled: false,
    ...reviewPaneFields(selected),
    ...patch,
  } as ClerkWorkspaceState;
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("source document controls", () => {
  test("uses the supplied page images and bounds page/zoom navigation", () => {
    render(
      <DocumentViewer
        pages={["first-source-page", "second-source-page"]}
        name="Scan"
      />,
    );
    expect(screen.getByAltText("Page 1 of Scan").getAttribute("src")).toContain(
      "first-source-page",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Previous page",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByAltText("Page 2 of Scan").getAttribute("src")).toContain(
      "second-source-page",
    );
    expect(
      (screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (let i = 0; i < 12; i++)
      fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByRole("status").textContent).toContain("300%");
    expect(
      (screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    for (let i = 0; i < 12; i++)
      fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(screen.getByRole("status").textContent).toContain("50%");
    expect(
      (screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByAltText("Page 1 of Scan")).toBeTruthy();
  });

  test("reserves rotated bounds, resets the view and recovers from a failed image", () => {
    render(<DocumentViewer pages={["source"]} name="Scan" singleImage />);
    const image = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperties(image, {
      naturalWidth: { value: 600 },
      naturalHeight: { value: 900 },
    });
    fireEvent.load(image);
    const originalHeight = image.parentElement!.style.height;
    fireEvent.click(screen.getByRole("button", { name: "Rotate clockwise" }));
    expect(image.style.transform).toContain("rotate(90deg)");
    expect(image.parentElement!.style.height).not.toBe(originalHeight);
    expect(image.parentElement!.style.height).toBe(image.style.width);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Reset document view" }),
    );
    expect(image.parentElement!.style.height).toBe(originalHeight);
    expect(image.style.transform).toContain("rotate(0deg)");
    fireEvent.error(image);
    expect(screen.getByRole("alert").textContent).toContain(
      "could not be displayed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry image" }));
    expect(screen.getByRole("img").getAttribute("src")).toContain("source");
  });

  test("resets page, rotation and zoom when the selected case changes", () => {
    const { rerender } = render(
      <DocumentViewer key="case-a" pages={["a", "b"]} name="A" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Rotate clockwise" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    rerender(<DocumentViewer key="case-b" pages={["c"]} name="B" />);
    expect(screen.getByRole("status").textContent).toBe(
      "Page 1 of 1 · 100% · 0°",
    );
  });

  test.each(["voice", "text"] as const)(
    "keeps the original %s text verbatim",
    (sourceType) => {
      const selected = makeCase({ sourceType });
      render(
        <CaseSourcePanels selected={selected} state={makeState(selected)} />,
      );
      expect(
        screen.getByRole("region", { name: "Original source text" })
          .textContent,
      ).toBe(selected.sourceText);
      expect(screen.queryByTestId("document-viewer")).toBeNull();
    },
  );

  test("scanned pages remain lazy with loading, retry, retention and empty states", () => {
    const selected = makeCase({ sourceType: "pdf", sourceText: null });
    const state = makeState(selected);
    const { rerender } = render(
      <CaseSourcePanels selected={selected} state={state} />,
    );
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View pages" }));
    expect(state.setPagesOpen).toHaveBeenCalledWith(true);
    rerender(
      <CaseSourcePanels
        selected={selected}
        state={{ ...state, pagesOpen: true, sourcePagesLoading: true }}
      />,
    );
    expect(screen.getByTestId("skeleton-source-pages")).toBeTruthy();
    rerender(
      <CaseSourcePanels
        selected={selected}
        state={{
          ...state,
          pagesOpen: true,
          sourcePagesError: new Error("Unavailable") as never,
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(state.refetchSourcePages).toHaveBeenCalledOnce();
    rerender(
      <CaseSourcePanels
        selected={selected}
        state={{
          ...state,
          pagesOpen: true,
          sourcePages: { pages: [], purged: true },
        }}
      />,
    );
    expect(screen.getByTestId("text-source-purged").textContent).toContain(
      "retention",
    );
    rerender(
      <CaseSourcePanels
        selected={selected}
        state={{
          ...state,
          pagesOpen: true,
          sourcePages: { pages: [], purged: false },
        }}
      />,
    );
    expect(
      screen.getByText("No source pages are available for this document."),
    ).toBeTruthy();
    rerender(
      <CaseSourcePanels
        selected={selected}
        state={{
          ...state,
          pagesOpen: true,
          sourcePages: { pages: ["actual-page"], purged: false },
        }}
      />,
    );
    expect(screen.getByRole("img").getAttribute("src")).toContain(
      "actual-page",
    );
  });
});

describe("review navigation", () => {
  test("critical values and expanded source snippets are never truncated", () => {
    const value = `Critical value ${"complete value ".repeat(60)}END`;
    const snippet = `Original source ${"verbatim source ".repeat(60)}END`;
    const selected = makeCase({
      extraction: {
        fields: [field({ value, sourceSnippet: snippet })],
        lines: [],
        model: "fixture",
        promptVersion: "v1",
      },
    });
    render(
      <CaseDetail
        state={makeState(selected, {
          openSnippets: new Set(["invoiceNumber"]),
        })}
      />,
    );
    expect(screen.getByTestId("row-field-invoiceNumber").textContent).toContain(
      value,
    );
    expect(screen.getByTestId("snippet-invoiceNumber").textContent).toContain(
      snippet,
    );
  });

  test("includes flagged, missing/low-confidence critical, preflight and incomplete input targets without treating visits as approval", () => {
    const selected = makeCase({
      extraction: {
        fields: [
          field(),
          field({ field: "dueDate", flagged: false, confidence: 0.89 }),
          field({ field: "currency", flagged: false, value: null }),
          field({ field: "issueDate", flagged: false, confidence: 0.9 }),
        ],
        lines: [],
        model: "fixture",
        promptVersion: "v1",
      },
      preflight: [
        { field: "invoiceNumber", message: "Check" },
        { field: "lines.0.quantity", message: "Check quantity" },
      ],
    });
    const result = fieldsNeedingReview(
      selected,
      {
        ...invoiceForm,
        firmId: "",
        lines: [{ ...invoiceForm.lines[0], vatRate: "" }],
      },
      null,
    );
    expect(result).toEqual([
      "invoiceNumber",
      "dueDate",
      "currency",
      "lines.0.quantity",
      "firmId",
      "lines.0.vatRate",
    ]);
    expect(
      fieldsNeedingReview(
        { ...selected, status: "approved" },
        invoiceForm,
        null,
      ),
    ).toEqual([]);
  });

  test("cycles to actual inputs, line cells and evidence-only issues, retaining snippets and metrics", () => {
    const selected = makeCase({
      preflight: [
        { field: "lines.0.quantity", message: "Check quantity" },
        { field: "unknownSourceField", message: "Inspect source" },
      ],
    });
    const state = makeState(selected, {
      queueMetrics: {
        corrections: [
          {
            field: "invoiceNumber",
            total: 20,
            overridden: 14,
            overrideRate: 0.7,
          },
        ],
      } as never,
    });
    render(<CaseDetail state={state} />);
    const next = screen.getByRole("button", {
      name: "Next field needing review",
    });
    next.focus();
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Invoice number"),
    );
    expect(state.setOpenSnippets).toHaveBeenCalled();
    fireEvent.click(next);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Line 1 quantity"),
    );
    fireEvent.click(next);
    expect(document.activeElement?.textContent).toBe("Inspect source");
    fireEvent.click(next);
    expect(document.activeElement).toBe(
      screen.getByLabelText("Invoice number"),
    );
    expect(state.decideCase.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("hint-invoiceNumber")).toBeTruthy();
  });

  test("notice aliases focus the corresponding editable deadline, amount and reference", () => {
    const selected = makeCase({
      kind: "notice",
      extraction: null,
      noticeExtraction: {
        noticeType: "demand_notice",
        fields: [
          field({ field: "referenceNumber" }),
          field({ field: "amountDemanded" }),
          field({ field: "responseDueDate" }),
        ],
        model: "fixture",
        promptVersion: "v1",
      },
    });
    render(
      <CaseDetail state={makeState(selected, { form: null, noticeForm })} />,
    );
    for (const label of ["Reference", "Amount", "Response due date"]) {
      fireEvent.click(
        screen.getByRole("button", { name: "Next field needing review" }),
      );
      expect(document.activeElement).toBe(screen.getByLabelText(label));
    }
  });
});

describe("approval summaries and existing guards", () => {
  test("the item summary preserves invalid values and never turns incomplete amounts into zero", () => {
    render(
      <InvoiceApprovalSummary
        form={{
          ...invoiceForm,
          currency: "",
          lines: [
            {
              description: "Pending item",
              quantity: "",
              unitPrice: "",
              vatRate: "101",
            },
          ],
        }}
        firms={firms}
        parties={parties}
      />,
    );
    const item = screen.getByTestId("summary-line-0");
    expect(within(item).getAllByText("Not entered")).toHaveLength(2);
    expect(
      within(item).getByText("Unit price (currency not set)"),
    ).toBeTruthy();
    expect(within(item).getByText("101")).toBeTruthy();
    expect(within(item).getByText("Check VAT rate")).toBeTruthy();
    expect(item.textContent).not.toContain("0.00");
  });

  test("invoice summary reflects edits but only the explicit approval sends the unchanged builder payload", () => {
    const decideCase =
      mutation() as unknown as ClerkWorkspaceState["decideCase"];
    function Harness() {
      const [form, setForm] = useState(invoiceForm);
      return (
        <InvoiceDecisionForm
          form={form}
          setForm={setForm}
          reason=""
          setReason={vi.fn()}
          firms={firms}
          parties={parties}
          partySuggestions={undefined}
          claimControls={<p>Claim controls retained</p>}
          caseId="case-1"
          decideCase={decideCase}
          approveDisabled={approveDisabledFor(form)}
          linesPreflightHit={false}
        />
      );
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Invoice number"), {
      target: { value: "INV-corrected" },
    });
    fireEvent.change(screen.getByLabelText("Currency"), {
      target: { value: "USD" },
    });
    fireEvent.change(screen.getByLabelText("Line 1 description"), {
      target: { value: "Corrected services" },
    });
    fireEvent.change(screen.getByLabelText("Line 1 quantity"), {
      target: { value: "3.125" },
    });
    fireEvent.change(screen.getByLabelText("Line 1 unit price"), {
      target: { value: "9999999999999999.99" },
    });
    fireEvent.change(screen.getByLabelText("Line 1 VAT rate"), {
      target: { value: "5" },
    });
    const summary = screen.getByRole("region", { name: "Approval summary" });
    expect(within(summary).getByText("INV-corrected")).toBeTruthy();
    expect(within(summary).getByText("USD")).toBeTruthy();
    const item = within(summary).getByTestId("summary-line-0");
    expect(item.textContent).toContain("Corrected services");
    expect(item.textContent).toContain("3.125");
    expect(item.textContent).toContain("Unit price (USD)");
    expect(item.textContent).toContain("9999999999999999.99");
    expect(item.textContent).toContain("5%");
    expect(summary.textContent).toContain("not submitted or filed");
    fireEvent.keyDown(screen.getByLabelText("Invoice number"), {
      key: "Enter",
    });
    expect(decideCase.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("Claim controls retained")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-approve-case"));
    expect(decideCase.mutate).toHaveBeenCalledExactlyOnceWith({
      id: "case-1",
      data: approveDecisionFromForm(
        {
          ...invoiceForm,
          invoiceNumber: "INV-corrected",
          currency: "USD",
          lines: [
            {
              description: "Corrected services",
              quantity: "3.125",
              unitPrice: "9999999999999999.99",
              vatRate: "5",
            },
          ],
        },
        "",
      ),
    });
  });

  test.each(["invalid", "pending"])(
    "invoice %s guard still blocks approval; reject/escalate still require a reason",
    (guard) => {
      const state = makeState(makeCase());
      state.decideCase.isPending = guard === "pending";
      render(
        <InvoiceDecisionForm
          form={invoiceForm}
          setForm={vi.fn()}
          reason=""
          setReason={vi.fn()}
          firms={firms}
          parties={parties}
          partySuggestions={undefined}
          claimControls={null}
          caseId="case-1"
          decideCase={state.decideCase}
          approveDisabled={guard === "invalid"}
          linesPreflightHit={false}
        />,
      );
      for (const testId of [
        "button-approve-case",
        "button-reject-case",
        "button-escalate-case",
      ]) {
        const button = screen.getByTestId(testId) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.click(button);
      }
      expect(state.decideCase.mutate).not.toHaveBeenCalled();
    },
  );

  test("notice summary describes only the obligation; incomplete and pending decisions remain guarded", () => {
    const decideNotice =
      mutation() as unknown as ClerkWorkspaceState["decideNotice"];
    const props = {
      noticeForm,
      setNoticeForm: vi.fn(),
      reason: "",
      setReason: vi.fn(),
      firms,
      parties,
      claimControls: null,
      caseId: "notice-1",
      decideNotice,
    };
    const { rerender } = render(
      <NoticeDecisionForm
        {...props}
        noticeForm={{ ...noticeForm, responseDueDate: "" }}
      />,
    );
    expect(
      (screen.getByTestId("button-approve-notice") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("button-approve-notice"));
    expect(decideNotice.mutate).not.toHaveBeenCalled();
    rerender(
      <NoticeDecisionForm
        {...props}
        decideNotice={
          {
            ...decideNotice,
            isPending: true,
          } as ClerkWorkspaceState["decideNotice"]
        }
      />,
    );
    expect(
      (screen.getByTestId("button-approve-notice") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    rerender(<NoticeDecisionForm {...props} />);
    const summary = screen.getByRole("region", { name: "Approval summary" });
    expect(summary.textContent).toContain("one open response obligation");
    expect(summary.textContent).toContain(
      "does not create an invoice, send a response or file anything",
    );
    expect(within(summary).getByText("2026-09-30")).toBeTruthy();
    expect(decideNotice.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-approve-notice"));
    expect(decideNotice.mutate).toHaveBeenCalledExactlyOnceWith({
      id: "notice-1",
      data: noticeDecisionFromForm(noticeForm, ""),
    });
  });

  test("claim and release keep their existing explicit mutation paths", () => {
    const selected = makeCase();
    const claimCase = mutation() as unknown as ClerkWorkspaceState["claimCase"];
    const releaseCase =
      mutation() as unknown as ClerkWorkspaceState["releaseCase"];
    const { rerender } = render(
      <ClaimControls
        selected={selected}
        claimCase={claimCase}
        releaseCase={releaseCase}
      />,
    );
    expect(claimCase.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Claim for review" }));
    expect(claimCase.mutate).toHaveBeenCalledExactlyOnceWith({
      id: selected.id,
    });
    rerender(
      <ClaimControls
        selected={{
          ...selected,
          status: "in_review",
          claimedBy: "operator",
          claimedAt: selected.createdAt,
        }}
        claimCase={claimCase}
        releaseCase={releaseCase}
      />,
    );
    expect(screen.getByTestId("badge-claimed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(releaseCase.mutate).toHaveBeenCalledExactlyOnceWith({
      id: selected.id,
    });
  });
});
