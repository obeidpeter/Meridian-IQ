// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useClerkActionsDialog } from "./use-clerk-actions-dialog";

afterEach(cleanup);

type Action = { kind: string };
type Decision = { id: string };

function harness(over: {
  isPending?: boolean;
  run?: (a: Action) => Promise<{ decision: Decision; drafts?: string[] | null }>;
}) {
  const onExecuted = vi.fn();
  const onCloseAfterDecision = vi.fn();
  const onError = vi.fn();
  const mutation = { isPending: over.isPending ?? false };
  const rendered = renderHook(() =>
    useClerkActionsDialog<Action, Decision, string>({
      mutation,
      run: over.run ?? (async () => ({ decision: { id: "d1" }, drafts: null })),
      onExecuted,
      onCloseAfterDecision,
      onError,
    }),
  );
  return { rendered, mutation, onExecuted, onCloseAfterDecision, onError };
}

describe("useClerkActionsDialog", () => {
  test("a successful run lands the decision and drafts, then only closeDialog fires the deferred invalidations (F1)", async () => {
    const { rendered, onExecuted, onCloseAfterDecision } = harness({
      run: async () => ({ decision: { id: "d1" }, drafts: ["a"] }),
    });
    act(() => rendered.result.current.beginConfirm({ kind: "submit_overdue" }));
    expect(rendered.result.current.dialogOpen).toBe(true);

    await act(() => rendered.result.current.runAction({ kind: "submit_overdue" }));
    expect(rendered.result.current.decision).toEqual({ id: "d1" });
    expect(rendered.result.current.drafts).toEqual(["a"]);
    expect(onExecuted).toHaveBeenCalledTimes(1);
    // The proposals/decisions refetch must NOT have fired yet — the open
    // results dialog would be unmounted by the emptied list.
    expect(onCloseAfterDecision).not.toHaveBeenCalled();

    act(() => rendered.result.current.closeDialog());
    expect(onCloseAfterDecision).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.dialogOpen).toBe(false);
    expect(rendered.result.current.drafts).toBeNull();
  });

  test("closeDialog is a no-op while the batch is in flight — read LIVE off the mutation object, stale closures included", () => {
    const { rendered, mutation, onCloseAfterDecision } = harness({});
    act(() => rendered.result.current.beginConfirm({ kind: "retry_failed" }));
    // Flip in-flight on the OBJECT without a re-render: the pre-extraction
    // cards read execute.isPending at call time, and the app pins exercise
    // exactly this stale-closure world.
    mutation.isPending = true;
    act(() => rendered.result.current.closeDialog());
    expect(rendered.result.current.dialogOpen).toBe(true);
    expect(onCloseAfterDecision).not.toHaveBeenCalled();
    mutation.isPending = false;
    act(() => rendered.result.current.closeDialog());
    expect(rendered.result.current.dialogOpen).toBe(false);
  });

  test("a failed run keeps the confirm step up and surfaces the error only", async () => {
    const boom = new Error("boom");
    const { rendered, onError, onExecuted, onCloseAfterDecision } = harness({
      run: async () => {
        throw boom;
      },
    });
    act(() => rendered.result.current.beginConfirm({ kind: "draft_chasers" }));
    await act(() => rendered.result.current.runAction({ kind: "draft_chasers" }));
    expect(onError).toHaveBeenCalledWith(boom);
    expect(onExecuted).not.toHaveBeenCalled();
    expect(rendered.result.current.decision).toBeNull();
    expect(rendered.result.current.confirming).toEqual({ kind: "draft_chasers" });
    // Closing from the (still-confirm) step never fires the deferred pair.
    act(() => rendered.result.current.closeDialog());
    expect(onCloseAfterDecision).not.toHaveBeenCalled();
  });
});
