/**
 * Bounded, focus-gated polling for screens that watch background work (Clerk
 * extraction on the capture screen, statement matching on reconciliation).
 * Two rules, kept as pure functions so the node:test suite can drive the
 * clock directly:
 *
 *  - a poll only runs while its screen is focused — a screen sitting buried
 *    in the nav stack must not keep hitting the network every 3 seconds;
 *  - a poll stops after PENDING_POLL_CAP_MS of CONTINUOUS processing — work
 *    stuck that long is the server watchdog's job, not the phone's battery's.
 *    The screen shows a quiet "still processing" line instead, and
 *    pull-to-refresh remains one gesture away.
 *
 * The screen-side wiring (focus tracking, the `since` ref) lives in
 * hooks/usePendingPoll.ts.
 */

export const PENDING_POLL_INTERVAL_MS = 3000;

/** Stop polling after 10 minutes of unbroken processing. */
export const PENDING_POLL_CAP_MS = 10 * 60 * 1000;

// The quiet line a capped screen shows in place of live updates.
export const PENDING_POLL_STALLED_MESSAGE =
  "Still processing — pull down to refresh, or check back in a bit.";

/**
 * Advance the continuous-processing clock: processing sets (or keeps) the
 * epoch-ms start; idle resets it to null. The cap therefore measures one
 * unbroken stretch of processing, and new work after a quiet spell always
 * gets a fresh window.
 */
export function trackPendingSince(
  since: number | null,
  processing: boolean,
  now: number,
): number | null {
  if (!processing) return null;
  return since ?? now;
}

/** Whether the continuous-processing stretch has outlived the cap. */
export function pollCapReached(
  since: number | null,
  now: number,
  capMs: number = PENDING_POLL_CAP_MS,
): boolean {
  return since !== null && now - since >= capMs;
}

/**
 * The refetchInterval decision: poll only while something is processing, the
 * screen is focused, and the cap hasn't been reached; otherwise stop (false).
 * react-query re-evaluates a function-form refetchInterval after every fetch
 * and on every options change, so a blur/refocus or a cap crossing takes
 * effect on the next evaluation.
 */
export function pendingPollInterval(opts: {
  processing: boolean;
  focused: boolean;
  since: number | null;
  now: number;
  capMs?: number;
  intervalMs?: number;
}): number | false {
  const {
    processing,
    focused,
    since,
    now,
    capMs = PENDING_POLL_CAP_MS,
    intervalMs = PENDING_POLL_INTERVAL_MS,
  } = opts;
  if (!processing || !focused) return false;
  if (pollCapReached(since, now, capMs)) return false;
  return intervalMs;
}
