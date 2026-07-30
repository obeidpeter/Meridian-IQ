/**
 * Pure helpers behind the Automation screen: proposal summarizing, the
 * approve-and-run confirm/outcome copy, the standing-approval (policy)
 * vocabulary, and the consent-grade grant copy.
 *
 * The load-bearing wording is imported from the web apps' shared
 * @workspace/format package via its Intl-free "action-copy" subpath —
 * importing the package ROOT would execute its module-load Intl formatter
 * construction, which mobile deliberately avoids (React Native's Hermes/JSC
 * ICU builds are inconsistent — see ./penalty.ts). Only the mobile-specific
 * pieces stay local: the RUNNABLE kind gate below, the mobile gate notes,
 * the pause/resume/revoke confirms, and the builders that need mobile's own
 * formatDateTime (policyStatusLine, decisionLine).
 *
 * Two deliberate mobile-v1 simplifications, stated here so they read as
 * decisions rather than gaps:
 *  - grants always use the shared DEFAULT cap of 10 per run (no numeric
 *    input) — the consent copy states the number being agreed to, and the
 *    web dialogs remain the place to choose a different ceiling;
 *  - only the submit kinds can be approved from the phone. draft_chasers
 *    returns transient reminder drafts that are shown ONCE on the response
 *    for a human to copy — mobile v1 has no clipboard affordance, so
 *    running it here would silently burn the drafts.
 */

import {
  actionConfirmDescription as sharedActionConfirmDescription,
  policyGrantDescription as sharedPolicyGrantDescription,
  policyPauseReasonLabel,
} from "@workspace/format/action-copy";
import { formatDateTime } from "./format";

// The shared vocabulary, re-exported verbatim: one home for the wording,
// pinned by lib/format's action-dialog-copy.test.ts (and re-pinned by
// automation.test.ts from this module's surface).
export {
  actionConfirmButtonLabel,
  actionOutcomeSummary,
  POLICY_CAP_DEFAULT,
  POLICY_KIND_LABELS,
  policyKindLabel,
  POLICY_PAUSE_REASON_LABELS,
} from "@workspace/format/action-copy";
export { policyPauseReasonLabel };

// ---- The automatable subset ------------------------------------------------
// GrantActionPolicyInput's enum: draft_chasers is excluded by design — its
// drafts exist only on the response for a human to read and send, which an
// unattended run cannot do. On mobile this set doubles as the RUNNABLE set
// (see the module comment), so it stays LOCAL rather than re-exporting the
// web's set: growing the web set must never silently widen what the phone
// can approve.

export const AUTOMATABLE_ACTION_KINDS = [
  "submit_overdue",
  "retry_failed",
] as const;
export type AutomatableActionKind = (typeof AUTOMATABLE_ACTION_KINDS)[number];

export function automatableActionKind(
  kind: string,
): AutomatableActionKind | null {
  return (AUTOMATABLE_ACTION_KINDS as readonly string[]).includes(kind)
    ? (kind as AutomatableActionKind)
    : null;
}

/**
 * Why a proposal carries no approve button on mobile, or null when it does.
 * draft_chasers gets the honest reason (its drafts are shown once and would
 * be lost); an off-contract kind from a newer server degrades to a pointer
 * at the web app rather than a button that could only ever fail.
 */
export function proposalMobileGateNote(kind: string): string | null {
  if (automatableActionKind(kind)) return null;
  if (kind === "draft_chasers") {
    return "Reminder drafts are shown once for you to read and copy, which needs the web app — approve this batch there so the drafts aren't lost.";
  }
  return "This action can't be approved from the mobile app yet — use the web app.";
}

// ---- Proposal display ------------------------------------------------------

/**
 * The one-line batch size under a proposal's title/why. When the server
 * truncated the batch, say so in its own words — a capped list must never
 * read as the whole backlog.
 */
export function proposalCountLine(action: {
  targets: readonly unknown[];
  targetCount: number;
  truncated: boolean;
}): string {
  if (action.truncated) {
    return `Showing the oldest ${action.targets.length} of ${action.targetCount} — approve this batch, then come back for the rest.`;
  }
  const n = action.targets.length;
  return `${n} invoice${n === 1 ? "" : "s"} in this batch.`;
}

// ---- Approve-and-run copy (shared with @workspace/format) ------------------

/**
 * The consent-grade confirm body for a batch: the shared builder with the
 * audience pinned to "sme" — the phone talks to the business owner in the
 * SME dialogs' words. (Only submit kinds reach this on mobile; see the
 * runnable-set gate above.)
 */
export function actionConfirmDescription(kind: string, count: number): string {
  return sharedActionConfirmDescription(kind, count, "sme");
}

// ---- Standing approvals ----------------------------------------------------

/**
 * One status line per live grant: paused grants lead with why (amber-worthy
 * — the sweep is NOT running); active grants say the cadence, the per-run
 * cap, and when the sweep last ran (or that it has not yet). Stays local:
 * it renders through mobile's own formatDateTime, not format's Intl one.
 */
export function policyStatusLine(policy: {
  pausedAt: string | null;
  pausedReason: string | null;
  maxTargetsPerRun: number;
  lastRunAt: string | null;
}): string {
  if (policy.pausedAt) return policyPauseReasonLabel(policy.pausedReason);
  const lastRun = policy.lastRunAt
    ? `last ran ${formatDateTime(policy.lastRunAt)}`
    : "has not run yet";
  return `runs daily · up to ${policy.maxTargetsPerRun} per run · ${lastRun}`;
}

/** The pause-prominence predicate: a paused grant means the sweep is dark. */
export function isPolicyPaused(policy: { pausedAt: string | null }): boolean {
  return policy.pausedAt !== null;
}

export function pausedPolicyCount(
  policies: readonly { pausedAt: string | null }[],
): number {
  return policies.filter(isPolicyPaused).length;
}

// The Home banner shown while any grant is paused (render-on-success from
// the policies query — a failed or dark query must add no dashboard noise).
export const AUTOMATION_PAUSED_HOME_MESSAGE =
  "Automation is paused — open Automation to review.";

/**
 * The consent-grade description in the "Automate daily" confirm: what a
 * standing approval DOES — including the per-run ceiling being granted, so
 * the copy states the number being consented to. The shared builder with
 * the audience pinned to "sme".
 */
export function policyGrantDescription(
  kind: string,
  maxTargetsPerRun: number,
): string {
  return sharedPolicyGrantDescription(kind, "sme", maxTargetsPerRun);
}

// The pause/resume/revoke confirms. Pause and resume are reversible
// housekeeping; revoke permanently removes the standing approval, so its
// confirm is the destructive one.
export const POLICY_PAUSE_CONFIRM = {
  title: "Pause this automation?",
  message:
    "The daily sweep will skip it until someone resumes it — the grant itself survives.",
  confirmLabel: "Pause",
} as const;

export const POLICY_RESUME_CONFIRM = {
  title: "Resume this automation?",
  message:
    "The daily sweep will pick it up again from its next run. Every run still re-checks consent, your access and each invoice.",
  confirmLabel: "Resume",
} as const;

export const POLICY_REVOKE_CONFIRM = {
  title: "Revoke this automation?",
  message:
    "This permanently removes the standing approval — Clerk stops running this action for you. You can grant it again later.",
  confirmLabel: "Revoke",
} as const;

// ---- Run record ------------------------------------------------------------

/**
 * One line per recorded decision — date, kind, the three counts, and the
 * "· auto" tag when a standing-approval run (not a fresh click) made it.
 * Stays local for the same reason as policyStatusLine: mobile's own
 * formatDateTime renders the date.
 */
export function decisionLine(decision: {
  createdAt: string;
  kind: string;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  policyId: string | null;
}): string {
  return `${formatDateTime(decision.createdAt)} · ${decision.kind} · ${
    decision.executedCount
  } executed · ${decision.skippedCount} skipped · ${decision.failedCount} failed${
    decision.policyId ? " · auto" : ""
  }`;
}
