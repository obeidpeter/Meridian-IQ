// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useActionPolicyControls } from "./use-action-policy-controls";

afterEach(cleanup);

type Action = { kind: string };
type Policy = { id: string; kind: string; pausedAt: string | null };

// Mirrors lib/format's gates so the machine is exercised the way the apps
// wire it (the exact copy/bounds stay pinned in lib/format's own tests).
const automatableKind = (kind: string) =>
  kind === "submit_overdue" || kind === "retry_failed" ? kind : null;
const parseCap = (raw: string) => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= 50 ? n : null;
};

function harness(over: {
  policies?: { enabled: boolean; policies: Policy[] };
  grantPending?: boolean;
  pausePending?: boolean;
}) {
  const grantCalls: unknown[] = [];
  const grant = {
    isPending: over.grantPending ?? false,
    mutate: (vars: unknown, callOpts?: { onSuccess?: () => void }) => {
      grantCalls.push(vars);
      callOpts?.onSuccess?.();
    },
  };
  const pause = { isPending: over.pausePending ?? false };
  const resume = { isPending: false };
  const revoke = { isPending: false };
  const rendered = renderHook(() =>
    useActionPolicyControls<Action, Policy, string>({
      clientPartyId: "cp-1",
      policies: over.policies,
      grant,
      pause,
      resume,
      revoke,
      automatableKind,
      parseCap,
      defaultCap: 10,
    }),
  );
  return { rendered, grantCalls };
}

describe("useActionPolicyControls", () => {
  test("beginAutomate opens on the action and resets the cap input to the default", () => {
    const { rendered } = harness({});
    act(() => rendered.result.current.setCapInput("37"));
    expect(rendered.result.current.capInput).toBe("37");

    act(() =>
      rendered.result.current.beginAutomate({ kind: "submit_overdue" }),
    );
    expect(rendered.result.current.automating).toEqual({
      kind: "submit_overdue",
    });
    // A previous edit never leaks into a fresh consent dialog.
    expect(rendered.result.current.capInput).toBe("10");
    expect(rendered.result.current.policyCap).toBe(10);

    act(() => rendered.result.current.closeAutomate());
    expect(rendered.result.current.automating).toBeNull();
  });

  test("an out-of-bounds cap means policyCap null and confirmGrant is a no-op — never a silent clamp", () => {
    const { rendered, grantCalls } = harness({});
    act(() =>
      rendered.result.current.beginAutomate({ kind: "submit_overdue" }),
    );
    act(() => rendered.result.current.setCapInput("51"));
    expect(rendered.result.current.policyCap).toBeNull();
    act(() => rendered.result.current.confirmGrant());
    expect(grantCalls).toEqual([]);
    // The dialog stays up for the user to fix the number.
    expect(rendered.result.current.automating).toEqual({
      kind: "submit_overdue",
    });
  });

  test("confirmGrant refuses a non-automatable kind even with a valid cap", () => {
    const { rendered, grantCalls } = harness({});
    act(() =>
      rendered.result.current.beginAutomate({ kind: "draft_chasers" }),
    );
    act(() => rendered.result.current.confirmGrant());
    expect(grantCalls).toEqual([]);
  });

  test("confirmGrant sends kind + client + the chosen cap, and success closes the dialog", () => {
    const { rendered, grantCalls } = harness({});
    act(() =>
      rendered.result.current.beginAutomate({ kind: "retry_failed" }),
    );
    act(() => rendered.result.current.setCapInput("25"));
    act(() => rendered.result.current.confirmGrant());
    expect(grantCalls).toEqual([
      {
        data: {
          kind: "retry_failed",
          clientPartyId: "cp-1",
          maxTargetsPerRun: 25,
        },
      },
    ]);
    expect(rendered.result.current.automating).toBeNull();
  });

  test("policyBusy aggregates over all four mutation objects", () => {
    expect(harness({}).rendered.result.current.policyBusy).toBe(false);
    expect(
      harness({ grantPending: true }).rendered.result.current.policyBusy,
    ).toBe(true);
    expect(
      harness({ pausePending: true }).rendered.result.current.policyBusy,
    ).toBe(true);
  });

  test("livePolicies/policyByKind/pausedCount derive from the payload — and an absent payload reads as no grants", () => {
    const paused: Policy = {
      id: "pol-1",
      kind: "submit_overdue",
      pausedAt: "2026-07-29T06:00:00Z",
    };
    const active: Policy = {
      id: "pol-2",
      kind: "retry_failed",
      pausedAt: null,
    };
    const { rendered } = harness({
      policies: { enabled: true, policies: [paused, active] },
    });
    expect(rendered.result.current.livePolicies).toEqual([paused, active]);
    expect(
      rendered.result.current.policyByKind.get("submit_overdue"),
    ).toEqual(paused);
    expect(rendered.result.current.policyByKind.has("draft_chasers")).toBe(
      false,
    );
    expect(rendered.result.current.pausedCount).toBe(1);

    const empty = harness({});
    expect(empty.rendered.result.current.livePolicies).toEqual([]);
    expect(empty.rendered.result.current.pausedCount).toBe(0);
  });
});
