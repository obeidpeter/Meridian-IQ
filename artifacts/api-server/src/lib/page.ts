// Bounded reads (R98) — the ONE home for list bounds. Every list route is
// bounded by construction: the whole response is buffered inside the
// per-request transaction (app.ts tenantContext) until COMMIT under the
// 30 s cap, so an unbounded list multiplies straight into memory and
// timeouts as a firm's book grows. A route therefore always applies
// pageBounds() — a bare request is the DEFAULT page, never the whole book —
// and a whole-population question (counts, sums, "is there any…") is a SQL
// aggregate, never a list folded in JS. Invalid paging input is a 400
// (parseOrThrow), never a silent fall-through to an unbounded query.

/** Rows a bare list request returns. */
export const LIST_DEFAULT_LIMIT = 100;
/** The most rows one list request may ask for. */
export const LIST_MAX_LIMIT = 200;
/**
 * Reference lists (parties) feed pickers and name maps that want the whole
 * working set in one read; their rows are small, so their ceiling is higher.
 */
export const REFERENCE_LIST_MAX_LIMIT = 500;

export interface PageQuery {
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface PageBounds {
  limit: number;
  offset: number;
}

/** Clamp a parsed limit/offset pair onto the route's bounds. */
export function pageBounds(
  query: PageQuery,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PageBounds {
  const maxLimit = opts.maxLimit ?? LIST_MAX_LIMIT;
  const defaultLimit = Math.min(
    opts.defaultLimit ?? LIST_DEFAULT_LIMIT,
    maxLimit,
  );
  return {
    limit: Math.min(query.limit ?? defaultLimit, maxLimit),
    offset: query.offset ?? 0,
  };
}
