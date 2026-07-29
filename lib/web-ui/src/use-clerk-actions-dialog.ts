import { useState } from "react";

// Headless core of the two "Clerk suggests" cards (refactoring survey items
// 25+26; extracted only after both twins gained render pins). The dialog's
// state machine is IDENTICAL in the SME dashboard card and its console twin,
// and it encodes three review-earned rules:
//   - F1 unmount guard: after a full batch executes, the refetched proposals
//     list is empty — the OPEN results dialog must survive that, so the
//     proposals/decisions refetches are deferred to closeDialog (the
//     onCloseAfterDecision callback), never fired from runAction.
//   - Mid-flight close gate: a batch in flight cannot be cancelled from the
//     dialog — closeDialog is a no-op while isPending, so the result is
//     always shown.
//   - Drafts are transient: they exist only in this dialog's state (the
//     server stores no draft; model output lands in the inference ledger),
//     and closing clears them.
// The JSX, the copy (lib/format's action* builders) and each app's own
// invalidation set stay in the apps — this hook owns only the machine.

export interface ClerkActionsDialog<A, D, R> {
  confirming: A | null;
  decision: D | null;
  drafts: R[] | null;
  // Render gates use this: the card must stay MOUNTED while the dialog is
  // up even when the proposals list has emptied (the F1 rule).
  dialogOpen: boolean;
  beginConfirm: (action: A) => void;
  runAction: (action: A) => Promise<void>;
  closeDialog: () => void;
}

export function useClerkActionsDialog<A, D, R>(opts: {
  // The mutation OBJECT (not a snapshot boolean): closeDialog reads
  // .isPending at CALL time, exactly as the pre-extraction cards did — the
  // twins' render pins exercise a stale-closure world (a bailed-out
  // rerender) where a live property read is the difference between "the
  // in-flight batch cannot be closed away" and a silently closable dialog.
  mutation: { readonly isPending: boolean };
  // Execute the batch; resolves with the decision and any transient drafts.
  run: (action: A) => Promise<{ decision: D; drafts?: R[] | null }>;
  // App-specific advisory invalidations, fired AFTER the decision lands in
  // state (not awaited by the caller's machinery — fire-and-forget).
  onExecuted: () => void;
  // The deferred proposals/decisions invalidations — fired from closeDialog
  // only when a decision was shown (the F1 rule).
  onCloseAfterDecision: () => void;
  // Failure surface (toast) — the machine keeps the confirm step up.
  onError: (e: unknown) => void;
}): ClerkActionsDialog<A, D, R> {
  const [confirming, setConfirming] = useState<A | null>(null);
  const [decision, setDecision] = useState<D | null>(null);
  const [drafts, setDrafts] = useState<R[] | null>(null);

  const runAction = async (action: A): Promise<void> => {
    try {
      const res = await opts.run(action);
      setDecision(res.decision);
      setDrafts(res.drafts ?? null);
      opts.onExecuted();
    } catch (e) {
      opts.onError(e);
    }
  };

  const closeDialog = (): void => {
    if (opts.mutation.isPending) return;
    if (decision !== null) opts.onCloseAfterDecision();
    setConfirming(null);
    setDecision(null);
    setDrafts(null);
  };

  return {
    confirming,
    decision,
    drafts,
    dialogOpen: confirming !== null || decision !== null,
    beginConfirm: (action: A) => setConfirming(action),
    runAction,
    closeDialog,
  };
}
