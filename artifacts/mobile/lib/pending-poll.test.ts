import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PENDING_POLL_CAP_MS,
  PENDING_POLL_INTERVAL_MS,
  pendingPollInterval,
  pollCapReached,
  trackPendingSince,
} from "./pending-poll.ts";

// The bounded, focus-gated poll behind the capture and reconciliation
// screens. The invariants: a buried screen never polls, and a poll never
// outlives 10 minutes of CONTINUOUS processing — a case stuck that long is
// the server watchdog's job, not the phone's.

const T0 = 1_753_000_000_000; // arbitrary epoch ms

test("trackPendingSince starts, holds and resets the continuous clock", () => {
  // Idle: no clock.
  assert.equal(trackPendingSince(null, false, T0), null);
  // Processing appears: clock starts now.
  assert.equal(trackPendingSince(null, true, T0), T0);
  // Still processing later: the ORIGINAL start is kept, not restarted.
  assert.equal(trackPendingSince(T0, true, T0 + 60_000), T0);
  // Work finishes: clock resets…
  assert.equal(trackPendingSince(T0, false, T0 + 120_000), null);
  // …so new work after a quiet spell gets a fresh window.
  assert.equal(trackPendingSince(null, true, T0 + 180_000), T0 + 180_000);
});

test("pollCapReached trips at the cap, not before, and never with no clock", () => {
  assert.equal(pollCapReached(null, T0 + PENDING_POLL_CAP_MS * 2), false);
  assert.equal(pollCapReached(T0, T0), false);
  assert.equal(pollCapReached(T0, T0 + PENDING_POLL_CAP_MS - 1), false);
  assert.equal(pollCapReached(T0, T0 + PENDING_POLL_CAP_MS), true);
  assert.equal(pollCapReached(T0, T0 + PENDING_POLL_CAP_MS + 1), true);
  // Env-style override.
  assert.equal(pollCapReached(T0, T0 + 5_000, 5_000), true);
});

test("pendingPollInterval polls only while processing, focused and under cap", () => {
  const base = { since: T0, now: T0 + 30_000 };
  assert.equal(
    pendingPollInterval({ processing: true, focused: true, ...base }),
    PENDING_POLL_INTERVAL_MS,
  );
  // Nothing processing: no poll (the pre-existing behaviour).
  assert.equal(
    pendingPollInterval({ processing: false, focused: true, ...base }),
    false,
  );
  // Screen buried in the nav stack: no poll, however busy the work is.
  assert.equal(
    pendingPollInterval({ processing: true, focused: false, ...base }),
    false,
  );
  // Cap reached: no poll even focused and processing.
  assert.equal(
    pendingPollInterval({
      processing: true,
      focused: true,
      since: T0,
      now: T0 + PENDING_POLL_CAP_MS,
    }),
    false,
  );
  // Tunables pass through.
  assert.equal(
    pendingPollInterval({
      processing: true,
      focused: true,
      since: T0,
      now: T0 + 1_000,
      intervalMs: 500,
    }),
    500,
  );
});

test("a full lifecycle: poll, blur, refocus, then stop at the cap", () => {
  let since: number | null = null;
  const decide = (processing: boolean, focused: boolean, now: number) => {
    since = trackPendingSince(since, processing, now);
    return pendingPollInterval({ processing, focused, since, now });
  };

  // A case starts processing: polling begins.
  assert.equal(decide(true, true, T0), PENDING_POLL_INTERVAL_MS);
  // User navigates away: polling pauses, but the clock keeps its start.
  assert.equal(decide(true, false, T0 + 60_000), false);
  assert.equal(since, T0);
  // Back on screen inside the window: polling resumes.
  assert.equal(decide(true, true, T0 + 120_000), PENDING_POLL_INTERVAL_MS);
  // Ten minutes of unbroken pending: polling stops for good.
  assert.equal(decide(true, true, T0 + PENDING_POLL_CAP_MS), false);
  // The work finally resolves, then NEW work arrives: fresh window, polling
  // again — the cap punishes one stuck stretch, not the screen forever.
  assert.equal(decide(false, true, T0 + PENDING_POLL_CAP_MS + 1_000), false);
  assert.equal(
    decide(true, true, T0 + PENDING_POLL_CAP_MS + 2_000),
    PENDING_POLL_INTERVAL_MS,
  );
});
