import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";

import {
  pendingPollInterval,
  pollCapReached,
  trackPendingSince,
} from "@/lib/pending-poll";

/**
 * Screen-side wiring for lib/pending-poll: tracks focus via expo-router's
 * useFocusEffect (react-query's focusManager is not wired up in this app, so
 * a buried screen would otherwise keep polling), keeps the
 * continuous-processing clock in a ref, and surfaces `stalled` so the screen
 * can show the quiet PENDING_POLL_STALLED_MESSAGE line once the cap stops
 * the poll.
 *
 * `interval(processing)` is the body of the query's `refetchInterval`
 * function: react-query re-evaluates it after every fetch and on every
 * options change (i.e. every render), which is what keeps the decision
 * current. Because it can run during render, the stalled flag only calls
 * setState when it actually flips.
 */
export function usePendingPoll(): {
  interval: (processing: boolean) => number | false;
  stalled: boolean;
} {
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const sinceRef = useRef<number | null>(null);
  const stalledRef = useRef(false);
  const [stalled, setStalled] = useState(false);

  const interval = (processing: boolean): number | false => {
    const now = Date.now();
    sinceRef.current = trackPendingSince(sinceRef.current, processing, now);
    const isStalled = processing && pollCapReached(sinceRef.current, now);
    if (isStalled !== stalledRef.current) {
      stalledRef.current = isStalled;
      setStalled(isStalled);
    }
    return pendingPollInterval({
      processing,
      focused,
      since: sinceRef.current,
      now,
    });
  };

  return { interval, stalled };
}
