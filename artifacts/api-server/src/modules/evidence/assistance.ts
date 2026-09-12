import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import Decimal from "decimal.js";
import type { EvidenceFile, EvidenceRequest } from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";

export type EvidenceSourceRequest = Pick<
  EvidenceRequest,
  | "id"
  | "firmId"
  | "clientPartyId"
  | "invoiceId"
  | "filingId"
  | "period"
  | "documentType"
  | "version"
>;

export type EvidenceSourceFile = Pick<
  EvidenceFile,
  | "id"
  | "requestId"
  | "firmId"
  | "filename"
  | "contentType"
  | "byteSize"
  | "sha256"
  | "scanStatus"
  | "createdAt"
  | "uploadedBy"
  | "scannedAt"
>;

export interface EvidenceExpectations {
  reference: string | null;
  amount: string | null;
  date: string | null;
  currency: string | null;
  documentType: string | null;
}

export interface EvidenceCheck {
  label: string;
  status: "match" | "mismatch" | "unknown";
  sourceValue: string | null;
  expectedValue: string | null;
}

export interface EvidenceAssistance {
  summary: string;
  suggestedDocumentType: string | null;
  checks: EvidenceCheck[];
  extractedText: string | null;
  clerkCaseId: string | null;
}

export interface EvidenceAssistanceDependencies {
  assertRequest(
    principal: Principal,
    id: string,
  ): Promise<EvidenceSourceRequest>;
  readFile(
    principal: Principal,
    id: string,
  ): Promise<{
    request: EvidenceSourceRequest;
    file: EvidenceSourceFile;
    bytes: Buffer;
  }>;
  expectations(
    principal: Principal,
    request: EvidenceSourceRequest,
  ): Promise<EvidenceExpectations>;
}

export const MAX_ASSISTANCE_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_LENGTH = 80_000;
export const MAX_EVIDENCE_PDF_PAGES = 20;
export const EVIDENCE_PDF_TIMEOUT_MS = 10_000;
let activePdfWorkers = 0;

// Static worker code only: neither bytes nor extracted text are interpolated
// into executable source. Process isolation also contains native PDF dependency
// crashes and makes the deadline enforceable during hostile decompression.
const PDF_TEXT_WORKER = `
process.once("message", async (workerData) => {
  let parser;
  let result;
  try {
    const { PDFParse } = require(workerData.modulePath);
    parser = new PDFParse({
      data: workerData.bytes, isEvalSupported: false, useSystemFonts: false,
      disableFontFace: true, enableXfa: false, verbosity: 0,
    });
    const info = await parser.getInfo({ parsePageInfo: false });
    if (!Number.isInteger(info.total) || info.total < 1 || info.total > workerData.maxPages) {
      result = { error: "PDF_PAGE_LIMIT" };
      return;
    }
    let text = "";
    for (let page = 1; page <= info.total; page++) {
      const pageText = await parser.getText({ partial: [page], pageJoiner: "" });
      text += (pageText.text || "") + "\\n";
      if (text.length > workerData.maxText) {
        result = { error: "PDF_TEXT_LIMIT" };
        return;
      }
    }
    result = { text };
  } catch {
    result = { error: "PDF_UNREADABLE" };
  } finally {
    if (parser) await parser.destroy().catch(() => {});
    process.send(result, () => process.exit(0));
  }
});
`;

export async function extractEvidencePdfText(
  bytes: Buffer,
  timeoutMs = EVIDENCE_PDF_TIMEOUT_MS,
): Promise<string> {
  if (bytes.length > MAX_ASSISTANCE_BYTES) {
    throw new DomainError(
      "PDF_BYTE_LIMIT",
      "PDF exceeds the assistance size limit",
      413,
    );
  }
  if (activePdfWorkers >= 2) {
    throw new DomainError(
      "PDF_BUSY",
      "Document text extraction is busy; try again",
      503,
    );
  }
  activePdfWorkers += 1;
  try {
    const modulePath = createRequire(import.meta.url).resolve("pdf-parse");
    const worker = spawn(
      process.execPath,
      [
        "--max-old-space-size=128",
        "--input-type=commonjs",
        "-e",
        PDF_TEXT_WORKER,
      ],
      {
        windowsHide: true,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // No provider credentials, DB configuration, or inherited Node hooks.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
    );
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let text: string | null = null;
      let failure: string | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure || text === null)
          reject(
            new DomainError(
              failure ?? "PDF_UNREADABLE",
              "PDF text extraction could not complete within its safety limits",
              422,
            ),
          );
        else resolve(text);
      };
      const timer = setTimeout(
        () => {
          failure = "PDF_TIMEOUT";
          worker.kill("SIGKILL");
        },
        Math.max(1, Math.min(timeoutMs, EVIDENCE_PDF_TIMEOUT_MS)),
      );
      worker.once("message", (message) => {
        const result = message as { text?: unknown; error?: unknown };
        if (
          typeof result.text === "string" &&
          result.text.length <= MAX_EXTRACTED_TEXT_LENGTH
        )
          text = result.text;
        else
          failure =
            typeof result.error === "string" ? result.error : "PDF_UNREADABLE";
      });
      worker.once("error", () => {
        failure ??= "PDF_UNREADABLE";
        worker.kill("SIGKILL");
      });
      worker.once("close", (code) => {
        if (code !== 0) failure ??= "PDF_UNREADABLE";
        finish();
      });
      worker.send(
        {
          bytes: Uint8Array.from(bytes),
          modulePath,
          maxPages: MAX_EVIDENCE_PDF_PAGES,
          maxText: MAX_EXTRACTED_TEXT_LENGTH,
        },
        (error) => {
          if (error) {
            failure ??= "PDF_UNREADABLE";
            worker.kill("SIGKILL");
          }
        },
      );
    });
  } finally {
    activePdfWorkers -= 1;
  }
}

// This is an additional integrity check, not a replacement for the scoped,
// clean-only storage reader. Names and document text never become instructions.
export function assertEvidenceSource(
  request: EvidenceSourceRequest,
  loaded: {
    request: EvidenceSourceRequest;
    file: EvidenceSourceFile;
    bytes: Buffer;
  },
  fileId: string,
): void {
  const { file, bytes } = loaded;
  if (
    loaded.request.id !== request.id ||
    loaded.request.firmId !== request.firmId ||
    loaded.request.clientPartyId !== request.clientPartyId ||
    file.id.toLowerCase() !== fileId.toLowerCase() ||
    file.requestId !== request.id ||
    file.firmId !== request.firmId
  ) {
    throw new DomainError("NOT_FOUND", "Evidence file not found", 404);
  }
  if (file.scanStatus !== "clean") {
    throw new DomainError(
      "EVIDENCE_FILE_NOT_CLEAN",
      "Only clean evidence files can be read",
      409,
    );
  }
  if (
    file.byteSize !== bytes.length ||
    createHash("sha256").update(bytes).digest("hex") !== file.sha256
  ) {
    throw new DomainError(
      "EVIDENCE_INTEGRITY",
      "Evidence file integrity check failed",
      409,
    );
  }
}

function unique(values: string[]): string | null {
  const distinct = [...new Set(values)];
  return distinct.length === 1 ? distinct[0] : null;
}

function labelledValues(text: string, label: RegExp): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = label.exec(line.trim());
    return match?.[1]?.trim() ? [match[1].trim()] : [];
  });
}

function normalizeReference(value: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(value)
    ? value.toUpperCase()
    : null;
}

function normalizeAmount(value: string): string | null {
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) return null;
  return new Decimal(value.replaceAll(",", "")).toFixed(2);
}

function normalizeDate(value: string): string | null {
  // Only unambiguous ISO dates: 01/02/2026 is deliberately not guessed.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? value
    : null;
}

function check(
  label: string,
  sourceValue: string | null,
  expectedValue: string | null,
  normalize: (value: string) => string | null = (value) => value.toLowerCase(),
): EvidenceCheck {
  const source = sourceValue === null ? null : normalize(sourceValue);
  const expected = expectedValue === null ? null : normalize(expectedValue);
  return {
    label,
    sourceValue,
    expectedValue,
    status:
      source === null || expected === null
        ? "unknown"
        : source === expected
          ? "match"
          : "mismatch",
  };
}

export function documentGroundedChecks(
  text: string | null,
  expected: EvidenceExpectations,
): {
  suggestedDocumentType: string | null;
  checks: EvidenceCheck[];
} {
  const source = text ?? "";
  const references = labelledValues(
    source,
    /^(?:invoice\s*(?:number|no\.?|#)|reference|reference\s*(?:number|no\.?|#)|receipt\s*(?:number|no\.?|#))\s*[:#]?\s+(.+)$/i,
  );
  const amounts = labelledValues(
    source,
    /^(?:grand\s+total|total\s+amount|amount\s+(?:paid|received)|invoice\s+total)\s*:?\s+(.+)$/i,
  );
  const parsedAmounts = amounts.map((value) =>
    /^(?:(NGN|USD|EUR|GBP)\s+)?(-?[\d,]+(?:\.\d{1,2})?)(?:\s+(NGN|USD|EUR|GBP))?$/i.exec(
      value,
    ),
  );
  const amount = parsedAmounts.every((value) => value !== null)
    ? unique(
        parsedAmounts.map((value) => normalizeAmount(value![2]) ?? "invalid"),
      )
    : null;
  const currencies = parsedAmounts.map((value) => {
    const prefix = value?.[1]?.toUpperCase();
    const suffix = value?.[3]?.toUpperCase();
    return prefix && suffix && prefix !== suffix
      ? null
      : (prefix ?? suffix ?? null);
  });
  const currency =
    currencies.length > 0 && currencies.every((value) => value !== null)
      ? unique(currencies as string[])
      : null;
  const dates = labelledValues(
    source,
    /^(?:invoice\s+date|issue\s+date|receipt\s+date|payment\s+date|date)\s*:?\s+(.+)$/i,
  );
  const types = labelledValues(
    source,
    /^(invoice|credit\s+note|(?:payment\s+)?receipt|bank\s+statement|purchase\s+order|delivery\s+note|tax\s+acknowledg(?:e)?ment|contract)\s*$/i,
  )
    .map((value) => value.toLowerCase().replace(/\s+/g, "_"))
    .map((value) =>
      value === "receipt"
        ? "payment_receipt"
        : value === "tax_acknowledgment"
          ? "tax_acknowledgement"
          : value,
    );
  const documentType = unique(types);
  return {
    suggestedDocumentType: documentType,
    checks: [
      check("Document type", documentType, expected.documentType),
      check(
        "Reference",
        unique(references),
        expected.reference,
        normalizeReference,
      ),
      check(
        "Amount",
        amount === "invalid" ? null : amount,
        expected.amount,
        normalizeAmount,
      ),
      check("Currency", currency, expected.currency),
      check("Document date", unique(dates), expected.date, normalizeDate),
    ],
  };
}

async function sourceText(
  file: EvidenceSourceFile,
  bytes: Buffer,
): Promise<{ text: string | null; note: string }> {
  let text: string;
  if (file.contentType === "application/pdf") {
    try {
      text = await extractEvidencePdfText(bytes);
    } catch (error) {
      if (
        error instanceof DomainError &&
        [
          "PDF_PAGE_LIMIT",
          "PDF_TEXT_LIMIT",
          "PDF_TIMEOUT",
          "PDF_BUSY",
        ].includes(error.code)
      ) {
        return {
          text: null,
          note: "PDF text extraction reached its safety limits or is busy. No partial-document checks were made; visual review is required. No OCR or AI inference was performed.",
        };
      }
      return {
        text: null,
        note: "PDF text extraction was unavailable. Visual review is required; no OCR or AI inference was performed.",
      };
    }
    if (!text.trim()) {
      return {
        text: null,
        note: "This PDF has no selectable text. Visual review is required; no OCR or AI inference was performed.",
      };
    }
  } else if (file.contentType === "text/plain") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return {
        text: null,
        note: "The original is not valid UTF-8 text. Manual review is required; no OCR or AI inference was performed.",
      };
    }
  } else {
    return {
      text: null,
      note: "This file needs visual review in the source document workflow. No OCR or AI inference was performed.",
    };
  }
  if (text.length > MAX_EXTRACTED_TEXT_LENGTH) {
    return {
      text: null,
      note: "The extracted text exceeds the assistance limit. No partial-document checks were made; manual review is required.",
    };
  }
  return {
    text: text.trim() || null,
    note: "Checks use only labelled values in the original document text; missing or ambiguous values remain unknown. No OCR or AI inference was performed.",
  };
}

const dependencies: EvidenceAssistanceDependencies = {
  assertRequest: async (principal, id) =>
    (await import("./access")).assertEvidenceRequest(principal, id),
  readFile: async (principal, id) =>
    (await import("./files")).readEvidenceFile(principal, id),
  expectations: async (principal, request) => {
    const expected: EvidenceExpectations = {
      reference: null,
      amount: null,
      date: null,
      currency: null,
      documentType:
        request.documentType === "other" ? null : request.documentType,
    };
    if (!request.invoiceId) return expected;
    const { getInvoiceWithLines } = await import("../invoice/service");
    const { assertCan, assertSameTenant, assertClientPartyScope } =
      await import("../auth/rbac");
    assertCan(principal, "invoice.read");
    const bundle = await getInvoiceWithLines(request.invoiceId);
    if (
      !bundle ||
      bundle.invoice.firmId !== request.firmId ||
      (request.clientPartyId !== null &&
        bundle.invoice.supplierPartyId !== request.clientPartyId)
    ) {
      throw new DomainError("NOT_FOUND", "Invoice anchor not found", 404);
    }
    assertSameTenant(principal, bundle.invoice.firmId);
    assertClientPartyScope(principal, bundle.invoice.supplierPartyId);
    return {
      ...expected,
      reference: bundle.invoice.invoiceNumber,
      amount: bundle.invoice.grandTotal,
      // A receipt/delivery date is not required to equal an invoice issue date.
      date: null,
      currency: bundle.invoice.currency,
    };
  },
};

export async function assistEvidenceRequest(
  principal: Principal,
  requestId: string,
  input: { fileId: string },
  deps: EvidenceAssistanceDependencies = dependencies,
): Promise<EvidenceAssistance> {
  const request = await deps.assertRequest(principal, requestId);
  const loaded = await deps.readFile(principal, input.fileId);
  assertEvidenceSource(request, loaded, input.fileId);
  if (loaded.bytes.length > MAX_ASSISTANCE_BYTES) {
    throw new DomainError(
      "EVIDENCE_ASSISTANCE_TOO_LARGE",
      "Evidence exceeds the 10 MB assistance limit",
      413,
    );
  }
  const expected = await deps.expectations(principal, request);
  const source = await sourceText(loaded.file, loaded.bytes);
  const result = documentGroundedChecks(source.text, expected);
  // Reauthorize after parsing; no source text is persisted or passed to inference.
  const current = await deps.assertRequest(principal, requestId);
  const currentFile = await deps.readFile(principal, input.fileId);
  assertEvidenceSource(current, currentFile, input.fileId);
  if (current.version !== request.version) {
    throw new DomainError(
      "EVIDENCE_CHANGED",
      "Evidence request changed; run the checks again",
      409,
    );
  }
  if (
    currentFile.file.sha256 !== loaded.file.sha256 ||
    currentFile.file.contentType !== loaded.file.contentType
  ) {
    throw new DomainError(
      "EVIDENCE_CHANGED",
      "Evidence file changed; run the checks again",
      409,
    );
  }
  return {
    summary: `Original file ${loaded.file.id}, ${loaded.file.contentType}, ${loaded.file.byteSize} bytes; SHA-256 verified. ${source.note} Human review is required.`,
    ...result,
    extractedText: source.text,
    // No case is linked merely because its name, hash, or firm happens to match.
    clerkCaseId: null,
  };
}
