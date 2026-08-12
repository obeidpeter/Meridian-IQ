import { Buffer } from "node:buffer";
import { DomainError } from "../../errors";
import { type UserContent } from "../gateway";
import {
  docImageUserContent,
  docScanUserContent,
  fenceUntrusted,
} from "../prompts";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // decoded

export function decodeBase64Checked(b64: string, label: string): Buffer {
  const cleaned = b64.replace(/^data:[^;]+;base64,/, "");
  let buf: Buffer;
  try {
    buf = Buffer.from(cleaned, "base64");
  } catch {
    throw new DomainError("BAD_UPLOAD", `${label} is not valid base64`, 400);
  }
  if (buf.length === 0) {
    throw new DomainError("BAD_UPLOAD", `${label} is empty`, 400);
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new DomainError(
      "UPLOAD_TOO_LARGE",
      `${label} exceeds the 5 MB upload limit`,
      413,
    );
  }
  return buf;
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    // pageJoiner "" disables pdf-parse's "-- N of M --" page markers; without
    // this a textless scan still "has text" (the markers) and the no-text
    // detection that routes scans to the vision path can never fire.
    const result = await parser.getText({ pageJoiner: "" });
    return result.text ?? "";
  } catch {
    throw new DomainError(
      "PDF_UNREADABLE",
      "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
      422,
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// Scanned-PDF intake (Clerk idea #1). Most real Nigerian SME documents are
// scans and phone-photo PDFs with no text layer; instead of rejecting them,
// render the pages to images (pdf-parse's pdfjs + @napi-rs/canvas stack —
// already in the tree for text extraction) and run them through the SAME
// vision extraction as an image upload: same gateway, ledger, budget,
// duplicate guard and human review.
//
// One capture is ONE invoice, so the page cap is deliberately small: it
// bounds vision-token cost per call and keeps multi-invoice bundles on the
// batch path where segmentation belongs.
export const MAX_SCAN_PAGES = 4;
const SCAN_RENDER_WIDTH = 1600;

export async function rasterizePdfScan(buf: Buffer): Promise<string[]> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buf });
  try {
    const shot = await parser.getScreenshot({
      first: MAX_SCAN_PAGES,
      desiredWidth: SCAN_RENDER_WIDTH,
    });
    if (shot.total > MAX_SCAN_PAGES) {
      throw new DomainError(
        "SCAN_TOO_LONG",
        `This scan has ${shot.total} pages; a single capture takes at most ${MAX_SCAN_PAGES}. Upload just the invoice's pages, or split the document.`,
        422,
      );
    }
    const pages = shot.pages
      .map((p) => p.dataUrl?.replace(/^data:image\/png;base64,/, "") ?? "")
      .filter((p) => p.length > 0);
    if (pages.length === 0) {
      throw new DomainError(
        "PDF_UNREADABLE",
        "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
        422,
      );
    }
    return pages;
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError(
      "PDF_UNREADABLE",
      "The PDF could not be read. Upload a clearer copy or an image of the invoice.",
      422,
    );
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// The vision-extraction counterpart of fenceDocument for a multi-page scan:
// the shared anti-injection scan builder (prompts.ts) with the invoice noun.
export function scanUserContent(pagesB64: string[]): UserContent {
  return docScanUserContent("The invoice", pagesB64);
}

// Shared text/pdf intake validation for single-case and batch intake: the
// upload guards, decode/extract pipeline and error strings live here so the
// two paths cannot drift. Only the PDF_NO_TEXT advice sentence differs per
// caller.
export async function resolveTextSource(
  sourceType: "text" | "pdf",
  input: { text?: string; pdfBase64?: string },
  pdfNoTextAdvice: string,
): Promise<string> {
  if (sourceType === "text") {
    if (!input.text?.trim()) {
      throw new DomainError(
        "BAD_UPLOAD",
        "text is required for a text source",
        400,
      );
    }
    return input.text; // NOT trimmed — trimming would change the stored sourceText and the duplicate-detection hash
  }
  if (!input.pdfBase64) {
    throw new DomainError(
      "BAD_UPLOAD",
      "pdfBase64 is required for a pdf source",
      400,
    );
  }
  const buf = decodeBase64Checked(input.pdfBase64, "PDF");
  const text = (await extractPdfText(buf)).trim();
  if (!text) {
    throw new DomainError(
      "PDF_NO_TEXT",
      `The PDF contains no selectable text (it is probably a scan). ${pdfNoTextAdvice}`,
      422,
    );
  }
  return text;
}

export function fenceDocument(text: string): string {
  return fenceUntrusted("invoice document content", "DOCUMENT", text);
}

// The notice lane's fence/user-content builders — the same anti-injection
// shapes as the invoice trio below, with the document noun corrected so the
// prompt never calls a notice an invoice. Shared by first-time intake and
// retries (retryExtraction re-fences with the case's own kind).
function fenceNoticeDocument(text: string): string {
  return fenceUntrusted(
    "tax-authority notice content",
    "NOTICE DOCUMENT",
    text,
  );
}

function noticeImageUserContent(
  contentType: string,
  b64: string,
): UserContent {
  return docImageUserContent("The tax-authority notice", contentType, b64);
}

function noticeScanUserContent(pagesB64: string[]): UserContent {
  return docScanUserContent("The tax-authority notice", pagesB64);
}

// The image counterpart of fenceDocument: the shared anti-injection image
// builder (prompts.ts) with the invoice noun. Shared by first-time intake and
// retries so the injection-hardening text for images is maintained in one
// place.
function imageUserContent(
  contentType: string,
  b64: string,
): UserContent {
  return docImageUserContent("The invoice", contentType, b64);
}

// One lane-dispatch table per document kind. Retry and first-time intake
// select the lane ONCE and share these records — the notice/invoice builder
// pick is never re-decided per source branch — so the "same wording as
// first-time intake" guarantee on retry is structural: a new source type (or
// documentKind) cannot silently drift one path.
export const INVOICE_CONTENT_BUILDERS = {
  fence: fenceDocument,
  image: imageUserContent,
  scan: scanUserContent,
} as const;
export const NOTICE_CONTENT_BUILDERS = {
  fence: fenceNoticeDocument,
  image: noticeImageUserContent,
  scan: noticeScanUserContent,
} as const;
