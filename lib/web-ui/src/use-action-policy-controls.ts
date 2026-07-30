import { useState } from "react";

// Headless core of the standing-approvals (round 28) control block the two
// "Clerk suggests" cards carry — the sibling of useClerkActionsDialog, and
// extracted under the same rules (both twins hold render pins; the machine
// was verbatim-identical in the SME dashboard card and its console twin).
// The hook owns:
//   - the grant dialog's state: which proposal is awaiting the
//     standing-approval confirm (`automating`), and the raw cap input
//     (string — the field must survive a cleared box mid-edit), reset to
//     the default each time the dialog opens;
//   - the single validity gate: `parseCap` (lib/format's parsePolicyCap) —
//     out-of-bounds means `policyCap` is null and confirmGrant is a no-op
//     (the confirm button disables), never a silent clamp;
//   - the grant-confirm handler: submit kinds only (`automatableKind`),
//     closing the dialog on success via the per-call onSuccess;
//   - the derivations off the policies payload: livePolicies, policyByKind
//     (which proposals already carry a grant), and pausedCount (a paused
//     grant means the sweep is NOT running — amber-worthy in the header).
// The four orval mutations, their onSuccess/onError wiring (queryClient
// invalidation, toast) and all JSX stay in the apps — this hook has zero
// runtime deps beyond React, so the mutations are passed in as OBJECTS and
// isPending is read live at call time (the same documented rule as
// useClerkActionsDialog's `mutation` option).

export interface ActionPolicyControls<
  A extends { kind: string },
  P extends { id: string; kind: string; pausedAt: string | null },
> {
  /** The proposal awaiting the standing-approval confirm, or null. */
  automating: A | null;
  /** The raw per-run-cap input (string: must survive a cleared box). */
  capInput: string;
  setCapInput: (raw: string) => void;
  /** parseCap over capInput — null means "not grantable yet". */
  policyCap: number | null;
  /** Open the grant dialog for a proposal, resetting the cap input. */
  beginAutomate: (action: A) => void;
  closeAutomate: () => void;
  /** Grant: no-op unless the kind is automatable AND the cap parses. */
  confirmGrant: () => void;
  /** Any of the four policy mutations in flight (this render). */
  policyBusy: boolean;
  livePolicies: P[];
  policyByKind: Map<string, P>;
  pausedCount: number;
}

export function useActionPolicyControls<
  A extends { kind: string },
  P extends { id: string; kind: string; pausedAt: string | null },
  K extends string,
>(opts: {
  clientPartyId: string;
  /** The policies query payload (undefined while loading/failed). */
  policies: { enabled: boolean; policies: P[] } | undefined;
  // The four mutation OBJECTS (not snapshots): .isPending and .mutate are
  // read live off the object at call time.
  grant: {
    readonly isPending: boolean;
    mutate(
      variables: {
        data: { kind: K; clientPartyId: string; maxTargetsPerRun: number };
      },
      options?: { onSuccess?: () => void },
    ): void;
  };
  pause: { readonly isPending: boolean };
  resume: { readonly isPending: boolean };
  revoke: { readonly isPending: boolean };
  /** lib/format's automatableActionKind: the submit-kind gate. */
  automatableKind: (kind: string) => K | null;
  /** lib/format's parsePolicyCap: the one validity gate. */
  parseCap: (raw: string) => number | null;
  /** lib/format's POLICY_CAP_DEFAULT: what the input resets to. */
  defaultCap: number;
}): ActionPolicyControls<A, P> {
  // Which submit-kind proposal is awaiting the standing-approval confirm.
  const [automating, setAutomating] = useState<A | null>(null);
  const [capInput, setCapInput] = useState(String(opts.defaultCap));
  const policyCap = opts.parseCap(capInput);

  const beginAutomate = (action: A): void => {
    setCapInput(String(opts.defaultCap));
    setAutomating(action);
  };

  const closeAutomate = (): void => setAutomating(null);

  const confirmGrant = (): void => {
    const kind = automating && opts.automatableKind(automating.kind);
    if (!kind || policyCap === null) return;
    opts.grant.mutate(
      {
        data: {
          kind,
          clientPartyId: opts.clientPartyId,
          maxTargetsPerRun: policyCap,
        },
      },
      { onSuccess: closeAutomate },
    );
  };

  const policyBusy =
    opts.grant.isPending ||
    opts.pause.isPending ||
    opts.resume.isPending ||
    opts.revoke.isPending;
  const livePolicies = opts.policies?.policies ?? [];
  const policyByKind = new Map(livePolicies.map((p) => [p.kind, p]));
  const pausedCount = livePolicies.filter((p) => p.pausedAt).length;

  return {
    automating,
    capInput,
    setCapInput,
    policyCap,
    beginAutomate,
    closeAutomate,
    confirmGrant,
    policyBusy,
    livePolicies,
    policyByKind,
    pausedCount,
  };
}
