/**
 * Pure helpers behind the Automation screen: proposal summarizing, the
 * approve-and-run confirm/outcome copy, the standing-approval (policy)
 * vocabulary, and the consent-grade grant copy.
 *
 * The load-bearing wording is ported verbatim from the web apps' shared
 * @workspace/format package (lib/format/src/index.ts) — mobile does not
 * depend on that web-shared package, so the copy lives in this RN-free
 * module; keep the two in sync when the wording changes there.
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

import { formatDateTime } from "./format";

// ---- The automatable subset ------------------------------------------------
// GrantActionPolicyInput's enum: draft_chasers is excluded by design — its
// drafts exist only on the response for a human to read and send, which an
// unattended run cannot do. On mobile this set doubles as the RUNNABLE set
// (see the module comment).

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

// ---- Approve-and-run copy (ported from @workspace/format) ------------------

/**
 * The consent-grade confirm body for a submit-kind batch. Ported from
 * actionConfirmDescription's submit branch (the SME/console texts are
 * identical for submit kinds).
 */
export function actionConfirmDescription(kind: string, count: number): string {
  const s = count === 1 ? "" : "s";
  return `This ${kind === "retry_failed" ? "resubmits" : "submits"} ${count} invoice${s} to the e-invoicing rails through the ordinary path — validation, consent and any approval policy all apply. Each invoice is re-checked at this moment; anything already processed or no longer eligible is skipped, and the decision is recorded under your name.`;
}

export function actionConfirmButtonLabel(kind: string, count: number): string {
  const s = count === 1 ? "" : "s";
  return kind === "draft_chasers"
    ? `Draft ${count} reminder${s}`
    : `Approve ${count} invoice${s}`;
}

export function actionOutcomeSummary(decision: {
  kind: string;
  executedCount: number;
  failedCount: number;
  skippedCount: number;
}): string {
  return `${decision.executedCount} ${
    decision.kind === "draft_chasers" ? "drafted" : "submitted"
  } · ${decision.failedCount} need attention · ${decision.skippedCount} skipped.`;
}

// ---- Standing approvals ----------------------------------------------------

// The per-run ceiling every mobile grant carries (the web dialogs' shared
// default; the contract allows 1..50, chosen there).
export const POLICY_CAP_DEFAULT = 10;

// Keyed by the automatable kinds. A kind an older client does not know
// renders through the fallback in policyKindLabel, never as a blank.
export const POLICY_KIND_LABELS: Record<string, string> = {
  submit_overdue: "Auto-submit overdue invoices",
  retry_failed: "Auto-retry failed submissions",
};

export function policyKindLabel(kind: string): string {
  return POLICY_KIND_LABELS[kind] ?? kind;
}

// Why a grant is paused, in card-sized words. The tripwire reasons are the
// sweep's own vocabulary (modules/clerk/action-policies.ts); "manual" is a
// human pause.
export const POLICY_PAUSE_REASON_LABELS: Record<string, string> = {
  manual: "paused manually",
  grantor_inactive: "paused — the granter's access changed",
  consent_missing: "paused — compliance consent is missing",
  failed_targets: "paused — too many failures in the last run",
  unknown_kind: "paused — this action kind can't run automatically",
  rail_rejections:
    "paused — the last run's submissions were rejected by the rails",
  engagement_closed: "paused — the engagement with this client has ended",
  run_error: "paused — the last run hit an unexpected error",
};

export function policyPauseReasonLabel(reason: string | null): string {
  return POLICY_PAUSE_REASON_LABELS[reason ?? "manual"] ?? `paused — ${reason}`;
}

/**
 * One status line per live grant: paused grants lead with why (amber-worthy
 * — the sweep is NOT running); active grants say the cadence, the per-run
 * cap, and when the sweep last ran (or that it has not yet).
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
 * the copy states the number being consented to. Ported from
 * policyGrantDescription (SME audience).
 */
export function policyGrantDescription(
  kind: string,
  maxTargetsPerRun: number,
): string {
  const s = maxTargetsPerRun === 1 ? "" : "s";
  const what =
    kind === "retry_failed"
      ? `resubmit up to ${maxTargetsPerRun} invoice${s} that failed on the rails`
      : `submit up to ${maxTargetsPerRun} invoice${s} past the statutory window`;
  return (
    `Clerk will run this check every day and ${what} under your name, without asking again each day. ` +
    `Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.`
  );
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
