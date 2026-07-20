// The invoice-PDF download idiom: like the vault's CSV export, the fetch is
// a plain same-origin navigation — auth rides the session cookie and the
// endpoint answers with the PDF bytes — but through a temporary anchor so
// the `download` attribute names the saved file after the invoice.

/**
 * Saved-file name for an invoice PDF: "invoice-<number>.pdf" with any
 * filesystem-hostile characters (slashes in "INV/2026/001", quotes, etc.)
 * folded to single dashes. An invoice number that sanitizes away entirely
 * still yields a usable "invoice.pdf".
 */
export function invoicePdfFilename(invoiceNumber: string): string {
  const safe = invoiceNumber
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return safe ? `invoice-${safe}.pdf` : "invoice.pdf";
}

/**
 * Navigate an href as a named download: a temporary anchor click, same as
 * the import page's results download. Same-origin, so the session cookie
 * authenticates the request and the download attribute is honoured.
 */
export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
