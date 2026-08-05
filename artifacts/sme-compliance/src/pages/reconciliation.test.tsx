// @vitest-environment jsdom
// The scanned-statement preview→commit contract (0.40.0): the preview call
// carries the PDF, the COMMIT posts BACK the preview's proposedCsv (the
// server refuses pdfBase64 with commit:true), and editing the inputs drops
// the held preview so a stale proposedCsv can never commit.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { renderWithClient } from "../test-utils";
import type {
  BankStatement,
  BankStatementLine,
  MatchProposalView,
  NarrationSuggestionsInput,
  StatementImportInput,
  StatementImportResult,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  importCalls: [] as StatementImportInput[],
  importResult: null as unknown,
  capabilities: [] as string[],
  statements: [] as unknown[],
  proposals: [] as unknown[],
  lines: [] as unknown[],
  narrationCalls: [] as { statementId: string }[],
  narrationResult: null as unknown,
  reset() {
    this.importCalls = [];
    this.importResult = null;
    this.capabilities = [];
    this.statements = [];
    this.proposals = [];
    this.lines = [];
    this.narrationCalls = [];
    this.narrationResult = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const idleMutation = { mutateAsync: vi.fn(), isPending: false };
  const listOf = (data: () => unknown[]) => () => ({
    data: data(),
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  });
  return {
    ...actual,
    useGetMe: () => ({
      data: { clientPartyId: "cp-1", capabilities: harness.capabilities },
    }),
    useImportBankStatement: () => ({
      isPending: false,
      mutateAsync: (vars: { data: StatementImportInput }) => {
        harness.importCalls.push(vars.data);
        return Promise.resolve(harness.importResult);
      },
    }),
    useListBankStatements: listOf(() => harness.statements),
    useListBankStatementProposals: listOf(() => harness.proposals),
    useListBankStatementLines: listOf(() => harness.lines),
    useAcceptMatchProposal: () => idleMutation,
    useRejectMatchProposal: () => idleMutation,
    useBulkAcceptMatchProposals: () => idleMutation,
    useAssistMatchProposals: () => idleMutation,
    useSuggestNarrationMatches: () => ({
      isPending: false,
      mutateAsync: (vars: { data: NarrationSuggestionsInput }) => {
        harness.narrationCalls.push(vars.data);
        return Promise.resolve(harness.narrationResult);
      },
    }),
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import {
  Reconciliation,
  narrationChipFor,
  narrationCueLabel,
  narrationSuggestVisible,
  narrationSummaryLine,
  statementImportBody,
} from "./reconciliation";

const PROPOSED_CSV =
  "Date,Narration,Amount,Direction\n2026-07-01,NIP transfer,150000,credit";

function pdfPreview(
  over: Partial<StatementImportResult> = {},
): StatementImportResult {
  return {
    statementId: null,
    committed: false,
    proposedCsv: PROPOSED_CSV,
    formatKey: "clerk_scan_v1",
    accountRef: null,
    lineCount: 1,
    parsedCount: 1,
    parseRate: 1,
    rows: [
      {
        lineNo: 1,
        parseStatus: "parsed",
        valueDate: "2026-07-01",
        amount: "150000",
        direction: "credit",
        narration: "NIP transfer",
      },
    ],
    ...over,
  };
}

const renderPage = () => renderWithClient(<Reconciliation />);

async function loadPdf(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>(
    'input[type="file"]',
  );
  expect(input).toBeTruthy();
  // Node's File, not jsdom's: fileToBase64 needs File#arrayBuffer, which
  // jsdom does not implement.
  const { File: NodeFile } = await import("node:buffer");
  const file = new NodeFile([new Uint8Array([1, 2, 3, 4])], "scan.pdf", {
    type: "application/pdf",
  });
  fireEvent.change(input!, { target: { files: [file] } });
  // fileToBase64 is async — wait for the picked-PDF line to confirm state.
  await screen.findByTestId("text-pdf-loaded");
}

afterEach(cleanup);
beforeEach(() => {
  harness.reset();
});

describe("scanned-statement preview → commit", () => {
  test("preview posts the PDF; commit posts back the proposedCsv, never the PDF again", async () => {
    const { container } = renderPage();
    await loadPdf(container);

    harness.importResult = pdfPreview();
    fireEvent.click(screen.getByRole("button", { name: /check parsing/i }));
    await screen.findByTestId("banner-scanned-preview");

    // The preview call carried the PDF (commit:false).
    expect(harness.importCalls).toHaveLength(1);
    expect(harness.importCalls[0].commit).toBe(false);
    expect(harness.importCalls[0].pdfBase64).toBeTruthy();
    expect(harness.importCalls[0].csv).toBeUndefined();

    // Banner copy is truthful: the previewed rows ARE the commit.
    expect(
      screen.getByTestId("banner-scanned-preview").textContent,
    ).toContain("exactly what will be committed");

    // Commit: the held proposedCsv goes back as csv, formatKey unchanged.
    harness.importResult = pdfPreview({
      committed: true,
      statementId: "st-1",
      proposedCsv: null,
    });
    fireEvent.click(
      screen.getByRole("button", { name: /commit statement/i }),
    );
    await waitFor(() => expect(harness.importCalls).toHaveLength(2));
    const commitBody = harness.importCalls[1];
    expect(commitBody.commit).toBe(true);
    expect(commitBody.pdfBase64).toBeUndefined();
    expect(commitBody.csv).toBe(PROPOSED_CSV);
    expect(commitBody.formatKey).toBe("clerk_scan_v1");
    expect(commitBody.filename).toBe("scan.pdf");
    expect(commitBody.clientPartyId).toBe("cp-1");
  });

  test("editing the CSV textarea after a preview drops the held preview", async () => {
    const { container } = renderPage();
    await loadPdf(container);

    harness.importResult = pdfPreview();
    fireEvent.click(screen.getByRole("button", { name: /check parsing/i }));
    await screen.findByTestId("banner-scanned-preview");
    expect(
      screen.getByRole("button", { name: /commit statement/i }),
    ).toBeTruthy();

    // Typing switches to the CSV path and clears the report — the commit
    // button (and with it the held proposedCsv) is gone.
    fireEvent.change(screen.getByLabelText(/bank statement csv/i), {
      target: { value: "Date,Amount\n2026-07-02,1000" },
    });
    expect(
      screen.queryByRole("button", { name: /commit statement/i }),
    ).toBeNull();
    expect(screen.queryByTestId("banner-scanned-preview")).toBeNull();
  });
});

describe("statementImportBody", () => {
  const pdf = { name: "scan.pdf", base64: "cGRm" };

  test("a scanned preview (commit:false) sends the PDF", () => {
    expect(
      statementImportBody({
        clientPartyId: "cp-1",
        csv: "",
        pdf,
        report: null,
        commit: false,
        filename: "scan.pdf",
      }),
    ).toEqual({
      clientPartyId: "cp-1",
      pdfBase64: "cGRm",
      commit: false,
      filename: "scan.pdf",
    });
  });

  test("a scanned commit posts back the preview's proposedCsv with its formatKey", () => {
    expect(
      statementImportBody({
        clientPartyId: "cp-1",
        csv: "",
        pdf,
        report: pdfPreview(),
        commit: true,
        filename: "scan.pdf",
      }),
    ).toEqual({
      clientPartyId: "cp-1",
      csv: PROPOSED_CSV,
      formatKey: "clerk_scan_v1",
      commit: true,
      filename: "scan.pdf",
    });
  });

  test("an older-server preview without proposedCsv falls back to the PDF — the server stays the authority", () => {
    const body = statementImportBody({
      clientPartyId: "cp-1",
      csv: "",
      pdf,
      report: pdfPreview({ proposedCsv: null }),
      commit: true,
      filename: "scan.pdf",
    });
    expect(body.pdfBase64).toBe("cGRm");
    expect(body.csv).toBeUndefined();
  });

  test("the plain CSV path is unchanged", () => {
    expect(
      statementImportBody({
        clientPartyId: "cp-1",
        csv: "Date,Amount\n2026-07-02,1000",
        pdf: null,
        report: pdfPreview(),
        commit: true,
        filename: null,
      }),
    ).toEqual({
      clientPartyId: "cp-1",
      csv: "Date,Amount\n2026-07-02,1000",
      commit: true,
    });
  });
});

// ---- Narration match lane ---------------------------------------------------

function reconciledStatement(over: Partial<BankStatement> = {}): BankStatement {
  return {
    id: "st-1",
    firmId: "f-1",
    clientPartyId: "cp-1",
    formatKey: "gtb_csv_v1",
    filename: "july.csv",
    accountRef: null,
    uploadedByUserId: null,
    status: "reconciled",
    lineCount: 2,
    parsedCount: 2,
    createdAt: "2026-07-30T09:00:00Z",
    updatedAt: "2026-07-30T09:00:00Z",
    ...over,
  };
}

function midBandProposal(
  over: Partial<MatchProposalView> = {},
): MatchProposalView {
  return {
    id: "p-1",
    statementId: "st-1",
    statementLineId: "ln-1",
    invoiceId: "inv-1",
    invoiceNumber: "INV-001",
    invoiceStatus: "stamped",
    invoiceTotal: "150000",
    buyerName: "Acme Ltd",
    lineNo: 1,
    lineAmount: "150000",
    lineDate: "2026-07-01",
    narration: "NIP/ACME/INV001",
    confidence: "0.62",
    status: "proposed",
    createdAt: "2026-07-30T09:00:00Z",
    ...over,
  };
}

function statementLine(over: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    id: "ln-1",
    statementId: "st-1",
    lineNo: 1,
    valueDate: "2026-07-01",
    amount: "150000",
    direction: "credit",
    narration: "NIP/ACME/INV001",
    counterpartyRef: null,
    parseStatus: "parsed",
    parseError: null,
    rawLine: "2026-07-01,NIP/ACME/INV001,150000,credit",
    narrationSuggestion: null,
    createdAt: "2026-07-30T09:00:00Z",
    ...over,
  };
}

const suggestion = (over: Partial<NonNullable<BankStatementLine["narrationSuggestion"]>> = {}) => ({
  proposalId: "p-1" as string | null,
  invoiceId: "inv-1" as string | null,
  cue: "exact_reference" as string | null,
  at: "2026-07-30T10:00:00Z",
  ...over,
});

describe("narrationCueLabel", () => {
  test("maps the closed cue catalogue to client wording", () => {
    expect(narrationCueLabel("exact_reference")).toBe("exact reference");
    expect(narrationCueLabel("reference_fragment")).toBe("reference fragment");
    expect(narrationCueLabel("name_abbreviation")).toBe("name match");
    expect(narrationCueLabel("payer_context")).toBe("payer context");
    expect(narrationCueLabel("multi_invoice_hint")).toBe("part-payment hint");
  });

  test("unknown or absent cues yield null — never a leaked machine token", () => {
    expect(narrationCueLabel("brand_new_cue")).toBeNull();
    expect(narrationCueLabel(null)).toBeNull();
    expect(narrationCueLabel(undefined)).toBeNull();
    expect(narrationCueLabel("")).toBeNull();
  });
});

describe("narrationChipFor", () => {
  test("the suggested proposal gets the chip with its cue humanized", () => {
    const line = statementLine({ narrationSuggestion: suggestion() });
    expect(narrationChipFor(line, "p-1")).toBe(
      "Clerk suggests · exact reference",
    );
  });

  test("an unknown cue degrades to a bare 'Clerk suggests'", () => {
    const line = statementLine({
      narrationSuggestion: suggestion({ cue: "brand_new_cue" }),
    });
    expect(narrationChipFor(line, "p-1")).toBe("Clerk suggests");
  });

  test("a sibling proposal on the same line gets no chip", () => {
    const line = statementLine({ narrationSuggestion: suggestion() });
    expect(narrationChipFor(line, "p-2")).toBeNull();
  });

  test("an abstention (proposalId null) renders nothing on any card", () => {
    const line = statementLine({
      narrationSuggestion: suggestion({ proposalId: null, cue: null }),
    });
    expect(narrationChipFor(line, "p-1")).toBeNull();
  });

  test("no suggestion / unknown line yield no chip", () => {
    expect(narrationChipFor(statementLine(), "p-1")).toBeNull();
    expect(narrationChipFor(undefined, "p-1")).toBeNull();
  });
});

describe("narrationSuggestVisible", () => {
  const act = ["reconciliation.act"];

  test("shows for a middle-band undecided proposal with narration", () => {
    expect(narrationSuggestVisible([midBandProposal()], act)).toBe(true);
  });

  test("band edge: exactly 0.85 belongs to bulk accept, not this lane", () => {
    expect(
      narrationSuggestVisible([midBandProposal({ confidence: "0.85" })], act),
    ).toBe(false);
    expect(
      narrationSuggestVisible([midBandProposal({ confidence: "0.84" })], act),
    ).toBe(true);
  });

  test("a line without narration gives Clerk nothing to read", () => {
    expect(
      narrationSuggestVisible([midBandProposal({ narration: null })], act),
    ).toBe(false);
    expect(
      narrationSuggestVisible([midBandProposal({ narration: "   " })], act),
    ).toBe(false);
  });

  test("hidden without the reconciliation.act capability", () => {
    expect(narrationSuggestVisible([midBandProposal()], [])).toBe(false);
    expect(narrationSuggestVisible([midBandProposal()], undefined)).toBe(false);
    expect(
      narrationSuggestVisible([midBandProposal()], ["reconciliation.read"]),
    ).toBe(false);
  });

  test("decided proposals and empty lists never show the trigger", () => {
    expect(
      narrationSuggestVisible([midBandProposal({ status: "accepted" })], act),
    ).toBe(false);
    expect(narrationSuggestVisible([], act)).toBe(false);
    expect(narrationSuggestVisible(undefined, act)).toBe(false);
  });
});

describe("narrationSummaryLine", () => {
  test("headline numbers, pluralized", () => {
    expect(
      narrationSummaryLine({
        considered: 3,
        suggested: 1,
        abstained: 2,
        failed: 0,
      }),
    ).toBe("Clerk read 3 lines — 1 suggestion, 2 abstentions");
    expect(
      narrationSummaryLine({
        considered: 1,
        suggested: 0,
        abstained: 1,
        failed: 0,
      }),
    ).toBe("Clerk read 1 line — 0 suggestions, 1 abstention");
  });

  test("failures are appended only when any line failed", () => {
    expect(
      narrationSummaryLine({
        considered: 4,
        suggested: 2,
        abstained: 1,
        failed: 1,
      }),
    ).toBe("Clerk read 4 lines — 2 suggestions, 1 abstention, 1 failed");
  });
});

describe("narration match lane (render)", () => {
  function seedReconciled() {
    harness.statements = [reconciledStatement()];
    harness.proposals = [midBandProposal()];
  }

  async function selectStatement() {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: /july\.csv/i }));
    await screen.findByText(/3\. match proposals/i);
  }

  test("the trigger runs Clerk over the statement and reports the summary", async () => {
    harness.capabilities = ["reconciliation.act"];
    seedReconciled();
    harness.narrationResult = {
      statementId: "st-1",
      considered: 2,
      suggested: 1,
      abstained: 1,
      failed: 0,
      lines: [
        {
          statementLineId: "ln-1",
          outcome: "suggested",
          proposalId: "p-1",
          cue: "exact_reference",
        },
      ],
    };
    await selectStatement();

    const trigger = screen.getByTestId("button-narration-suggest");
    expect(trigger.textContent).toContain("Ask Clerk to read the narrations");
    fireEvent.click(trigger);

    const summary = await screen.findByTestId("narration-summary");
    expect(summary.textContent).toBe(
      "Clerk read 2 lines — 1 suggestion, 1 abstention",
    );
    expect(harness.narrationCalls).toEqual([{ statementId: "st-1" }]);
  });

  test("the chip marks only the proposal the line's suggestion points at", async () => {
    harness.capabilities = ["reconciliation.act"];
    harness.statements = [reconciledStatement()];
    harness.proposals = [
      midBandProposal(),
      midBandProposal({ id: "p-2", invoiceId: "inv-2", invoiceNumber: "INV-002" }),
    ];
    harness.lines = [statementLine({ narrationSuggestion: suggestion() })];
    await selectStatement();

    const chip = screen.getByTestId("narration-chip-p-1");
    expect(chip.textContent).toContain("Clerk suggests");
    expect(chip.textContent).toContain("exact reference");
    expect(screen.queryByTestId("narration-chip-p-2")).toBeNull();
  });

  test("without reconciliation.act the trigger never renders", async () => {
    harness.capabilities = [];
    seedReconciled();
    await selectStatement();
    expect(screen.queryByTestId("button-narration-suggest")).toBeNull();
  });
});
