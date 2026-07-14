// One UUID shape check for the whole server. Used to guard uuid-typed columns
// against non-UUID principal ids (the dev x-mock shim's "dev-user") and to
// collapse id path segments in metrics — sites that must agree on what counts
// as an id.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
