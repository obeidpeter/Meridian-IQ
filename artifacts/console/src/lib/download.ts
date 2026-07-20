// The CSV-export download idiom, mirrored from the SME app's lib/download:
// the fetch is a plain same-origin navigation — auth rides the session
// cookie and the endpoint answers with the CSV bytes — but through a
// temporary anchor so the `download` attribute names the saved file, instead
// of window.location.assign leaving the filename to the server.

/**
 * Saved-file name for a monthly CSV export: "<prefix>-<YYYY-MM>.csv". The
 * month is taken from the statement's ISO month-start date, so the file the
 * partner saves says which month it describes.
 */
export function monthCsvFilename(prefix: string, monthStart: string): string {
  const month = monthStart.slice(0, 7);
  return month ? `${prefix}-${month}.csv` : `${prefix}.csv`;
}

/**
 * Navigate an href as a named download: a temporary anchor click, same as
 * the SME app's export paths. Same-origin, so the session cookie
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
