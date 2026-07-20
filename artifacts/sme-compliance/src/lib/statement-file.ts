// Pure, DOM-free helpers for the reconciliation upload flow's scanned-PDF
// path (contract 0.39.0: StatementImportInput carries pdfBase64 next to csv).
// Extracted so the sniff and size guard can be unit-tested without mounting
// the page; reconciliation.tsx owns the async file reading and the toasts.

/** Scanned statement PDFs are capped server-side at 5 MB — reject early. */
export const MAX_STATEMENT_PDF_BYTES = 5 * 1024 * 1024;

/**
 * File-type sniff for the statement picker: a PDF by MIME type or .pdf
 * extension routes to the scanned path (Clerk reads it into lines);
 * everything else stays on the unchanged CSV text path. Mirrors the capture
 * page's isPdfFile test so the two upload surfaces can't disagree about
 * what counts as a PDF.
 */
export function isPdfStatementFile(name: string, type: string): boolean {
  return type === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

/**
 * Friendly size-guard message for an oversized scanned statement, or null
 * when the file fits the cap. Names the actual size in MB (one decimal) so
 * the fix is obvious — same shape as the capture page's voice-note guard.
 */
export function statementPdfSizeError(
  sizeBytes: number,
  maxBytes: number = MAX_STATEMENT_PDF_BYTES,
): string | null {
  if (sizeBytes <= maxBytes) return null;
  const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
  const capMb = Math.round(maxBytes / (1024 * 1024));
  return `Scanned statements are capped at ${capMb} MB; this file is ${mb} MB. Export a smaller date range, or upload your bank's CSV export instead.`;
}
