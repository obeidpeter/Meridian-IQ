// @vitest-environment jsdom
// The scanned-statement preview→commit contract (0.40.0): the preview call
// carries the PDF, the COMMIT posts BACK the preview's proposedCsv (the
// server refuses pdfBase64 with commit:true), and editing the inputs drops
// the held preview so a stale proposedCsv can never commit.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  StatementImportInput,
  StatementImportResult,
} from "@workspace/api-client-react";

const harness = vi.hoisted(() => ({
  importCalls: [] as StatementImportInput[],
  importResult: null as unknown,
  reset() {
    this.importCalls = [];
    this.importResult = null;
  },
}));

vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@workspace/api-client-react")>();
  const idleMutation = { mutateAsync: vi.fn(), isPending: false };
  const emptyList = {
    data: [],
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
  return {
    ...actual,
    useGetMe: () => ({ data: { clientPartyId: "cp-1" } }),
    useImportBankStatement: () => ({
      isPending: false,
      mutateAsync: (vars: { data: StatementImportInput }) => {
        harness.importCalls.push(vars.data);
        return Promise.resolve(harness.importResult);
      },
    }),
    useListBankStatements: () => emptyList,
    useListBankStatementProposals: () => emptyList,
    useAcceptMatchProposal: () => idleMutation,
    useRejectMatchProposal: () => idleMutation,
    useBulkAcceptMatchProposals: () => idleMutation,
    useAssistMatchProposals: () => idleMutation,
  };
});

// Import AFTER the mock so the page module binds the stand-ins.
import { Reconciliation, statementImportBody } from "./reconciliation";

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

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Reconciliation />
    </QueryClientProvider>,
  );
}

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
