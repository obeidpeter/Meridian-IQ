// The CSV-export download idiom: the fetch is a plain same-origin
// navigation — auth rides the session cookie and the endpoint answers with
// the CSV bytes — but through a temporary anchor so the `download` attribute
// names the saved file, instead of window.location.assign leaving the
// filename to the server. The anchor mechanics live in @workspace/web-ui.

/**
 * Saved-file name for a monthly CSV export: "<prefix>-<YYYY-MM>.csv". The
 * month is taken from the statement's ISO month-start date, so the file the
 * partner saves says which month it describes.
 */
export function monthCsvFilename(prefix: string, monthStart: string): string {
  const month = monthStart.slice(0, 7);
  return month ? `${prefix}-${month}.csv` : `${prefix}.csv`;
}

// Navigate an href as a named download. Same-origin, so the session cookie
// authenticates the request and the download attribute is honoured. The
// implementation is the shared @workspace/web-ui helper (one home for the
// temporary-anchor idiom); re-exported so console call sites keep importing
// from @/lib/download.
export { triggerDownload } from "@workspace/web-ui";
import { triggerDownload } from "@workspace/web-ui";

/**
 * Save in-memory bytes as a named download: wrap them in a Blob, click a
 * temporary object-URL anchor (via triggerDownload), then revoke the URL.
 */
export function downloadBlob(filename: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}
