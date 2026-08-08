export function takeQuerySecret(name: string): string | null {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const value = fragment.get(name) ?? url.searchParams.get(name);
  if (!value) return null;
  fragment.delete(name);
  url.searchParams.delete(name);
  url.hash = fragment.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
  return value;
}
