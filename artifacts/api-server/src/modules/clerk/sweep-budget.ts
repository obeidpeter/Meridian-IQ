// R106: the model-calling GENERATION sweeps — weekly firm digests, monthly
// client statements and advisory briefs, escalation triage — make up to one
// provider call per item, up to 20 items per pass, each bounded only by the
// provider client's 60 s timeout. That batch never fitted the 120 s default
// sweep budget, so a slow provider tripped the sweep timeout (and, since
// R105, the settle ceiling and its alert) on every pass while the work itself
// was legitimate. Each of those sweeps now registers its own budget and
// SLICES its batch to it: generation stops before the first item that could
// no longer complete within the budget, the sweep returns cleanly, and the
// remaining candidates are picked up by the next pass — every candidate query
// selects "not yet generated this period", so a slice is idempotent. A sliced
// pass is a success, not a timeout. The abort signal (the sweep timeout, or
// shutdown) is honoured at the same boundary, so the settle ceiling never
// has to abandon one of these sweeps. They all run best-effort and, since
// R106, after every critical sweep, so statutory work never waits on a model.

/** One provider call's worst case: the model client's own timeout (the
 *  model-provider package's client; pinned to its source by test). */
export const MODEL_CALL_BUDGET_MS = 60_000;

/** The registered timeout of every generation sweep: room for a full
 *  20-item batch at normal latency, or a handful of worst-case calls. */
export const GENERATION_SWEEP_TIMEOUT_MS = 5 * 60_000;

/** Headroom after the last model call for the row write and the delivery
 *  step that follows generation. */
export const SLICE_MARGIN_MS = 5_000;

/** The instant after which a generation loop must not start another item. */
export function generationDeadline(
  timeoutMs: number = GENERATION_SWEEP_TIMEOUT_MS,
  startedAt: number = Date.now(),
): number {
  return startedAt + timeoutMs - MODEL_CALL_BUDGET_MS - SLICE_MARGIN_MS;
}

/** True once a generation loop should stop BEFORE its next model call:
 *  the sweep was aborted (timeout or shutdown) or the deadline has passed. */
export function sliceExhausted(
  signal: AbortSignal | undefined,
  deadline: number,
  now: number = Date.now(),
): boolean {
  return Boolean(signal?.aborted) || now >= deadline;
}
