import { useEffect, useRef, useState } from "react";
import { evidenceError, evidenceErrorStatus } from "./evidence-helpers";

export function useEvidenceRead<T>(
  load: (signal: AbortSignal) => Promise<T>,
  keys: unknown[],
) {
  const [revision, refresh] = useState(0);
  const [state, setState] = useState<{
    key?: string;
    data?: T;
    loading: boolean;
    error: string | null;
  }>({ loading: true, error: null });
  const loader = useRef(load);
  const active = useRef<AbortController | null>(null);
  loader.current = load;
  const key = JSON.stringify(keys);
  useEffect(() => {
    const controller = new AbortController();
    active.current = controller;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      loading: true,
      error: null,
    }));
    loader.current(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted)
          setState({ key, data, loading: false, error: null });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: evidenceError(error),
          }));
      },
    );
    return () => controller.abort();
  }, [key, revision]);
  return {
    ...state,
    data: state.key === key ? state.data : undefined,
    loading: state.key !== key || state.loading,
    refresh: () => refresh((value) => value + 1),
    replace: (data: T) => {
      active.current?.abort();
      setState({ key, data, loading: false, error: null });
    },
  };
}

export function useEvidenceWrite<
  Input extends { clientRequestId: string },
  Result,
>(
  send: (input: Input) => Promise<Result>,
  success: (result: Result) => void,
  conflict?: () => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Input | null>(null);
  const inFlight = useRef(false);
  const attempt = useRef<Input | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function run(input?: Omit<Input, "clientRequestId">): Promise<boolean> {
    if (inFlight.current) return false;
    const payload =
      attempt.current ??
      (input
        ? ({ ...input, clientRequestId: crypto.randomUUID() } as Input)
        : null);
    if (!payload) return false;
    attempt.current = payload;
    setPending(payload);
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await send(payload);
      if (!mounted.current) return false;
      attempt.current = null;
      setPending(null);
      success(result);
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      const status = evidenceErrorStatus(error);
      if (
        status &&
        status >= 400 &&
        status < 500 &&
        status !== 408 &&
        status !== 429
      ) {
        attempt.current = null;
        setPending(null);
      }
      setError(evidenceError(error));
      if (status === 409) conflict?.();
      return false;
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { run, busy, error, pending, locked: busy || !!pending };
}
