// Invite/reset tokens ride the URL exactly once. Stripping the token from
// the address bar immediately is a deliberate log-hygiene control (history,
// referrer and analytics never see it) — but it also meant a plain refresh
// lost the token and dead-ended the page. The tab-scoped sessionStorage
// stash closes that gap: the same tab can re-mount and keep working, while
// the stash dies with the tab and the token itself is single-use
// server-side.

// Pure core, unit-tested in query-secret.test.ts: given the current href and
// any value stashed by an earlier mount in this tab, decide what to return,
// what URL to show, and what to stash.
export function resolveQuerySecret(
  name: string,
  href: string,
  stashed: string | null,
): { value: string | null; cleanedUrl: string | null; stash: string | null } {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const value = fragment.get(name) ?? url.searchParams.get(name);
  if (!value) {
    // No token in the URL — a refresh falls back to this tab's earlier stash.
    return { value: stashed, cleanedUrl: null, stash: null };
  }
  fragment.delete(name);
  url.searchParams.delete(name);
  url.hash = fragment.toString();
  return {
    value,
    cleanedUrl: `${url.pathname}${url.search}${url.hash}`,
    stash: value,
  };
}

function storageKey(name: string): string {
  return `meridianiq:query-secret:${window.location.pathname}:${name}`;
}

export function takeQuerySecret(name: string): string | null {
  let stashed: string | null = null;
  try {
    stashed = window.sessionStorage.getItem(storageKey(name));
  } catch {
    /* storage unavailable — refresh recovery is best-effort */
  }
  const { value, cleanedUrl, stash } = resolveQuerySecret(
    name,
    window.location.href,
    stashed,
  );
  if (cleanedUrl !== null) {
    window.history.replaceState(window.history.state, "", cleanedUrl);
  }
  if (stash !== null) {
    try {
      window.sessionStorage.setItem(storageKey(name), stash);
    } catch {
      /* storage unavailable — the token still works for this mount */
    }
  }
  return value;
}

// Called after the token is redeemed so a later visit in the same tab shows
// the guidance card instead of resubmitting a dead token.
export function clearQuerySecret(name: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(name));
  } catch {
    /* storage unavailable — nothing was stashed */
  }
}
