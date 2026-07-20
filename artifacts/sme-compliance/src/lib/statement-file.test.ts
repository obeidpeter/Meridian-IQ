import { describe, expect, test } from "vitest";
import {
  isPdfStatementFile,
  MAX_STATEMENT_PDF_BYTES,
  statementPdfSizeError,
} from "./statement-file";

describe("isPdfStatementFile", () => {
  test("routes by MIME type regardless of the filename", () => {
    expect(isPdfStatementFile("statement", "application/pdf")).toBe(true);
    expect(isPdfStatementFile("statement.csv", "application/pdf")).toBe(true);
  });

  test("routes by .pdf extension when the browser sends no useful type", () => {
    expect(isPdfStatementFile("gtb-march.pdf", "")).toBe(true);
    expect(isPdfStatementFile("GTB-MARCH.PDF", "application/octet-stream")).toBe(
      true,
    );
  });

  test("leaves CSV exports on the text path", () => {
    expect(isPdfStatementFile("statement.csv", "text/csv")).toBe(false);
    expect(isPdfStatementFile("statement.txt", "text/plain")).toBe(false);
    // The extension test is a suffix test, not a substring test.
    expect(isPdfStatementFile("statement.pdf.csv", "text/csv")).toBe(false);
  });
});

describe("statementPdfSizeError", () => {
  test("null for files at or under the cap", () => {
    expect(statementPdfSizeError(0)).toBeNull();
    expect(statementPdfSizeError(MAX_STATEMENT_PDF_BYTES)).toBeNull();
  });

  test("names the cap and the actual size for oversized files", () => {
    const msg = statementPdfSizeError(7.3 * 1024 * 1024);
    expect(msg).toContain("capped at 5 MB");
    expect(msg).toContain("7.3 MB");
    // The user is told what to do next, not just what went wrong.
    expect(msg).toContain("CSV");
  });

  test("respects an explicit cap override", () => {
    expect(statementPdfSizeError(2 * 1024 * 1024, 1024 * 1024)).toContain(
      "capped at 1 MB",
    );
    expect(statementPdfSizeError(1024, 2048)).toBeNull();
  });
});
