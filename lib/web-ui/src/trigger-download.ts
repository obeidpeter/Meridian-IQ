/**
 * Navigate an href as a named download: a temporary anchor click, so the
 * `download` attribute names the saved file instead of the server choosing.
 * Same-origin, so the session cookie authenticates the request.
 */
export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
