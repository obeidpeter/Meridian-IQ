// The Clerk-actions dialog/consent copy and the standing-approval (policy)
// vocabulary — the approve/results dialog copy the two web "Clerk suggests"
// cards render verbatim (survey items 25+26 — extracted with the headless
// machine in @workspace/web-ui), plus the round-28 grant/pause vocabulary.
// Pure builders so the exact wording has one home and unit tests (pinned in
// action-dialog-copy.test.ts); the SME/console texts differ ONLY where the
// audience does.
//
// This module must import NOTHING: it is exported as the
// "@workspace/format/action-copy" subpath so the mobile app can share the
// wording without executing the package root's module-load Intl formatter
// construction (React Native's Hermes/JSC ICU builds are inconsistent — see
// artifacts/mobile/lib/penalty.ts). Anything needing formatDateTime
// (policyStatusLine, decisionLine) stays in index.ts.

// How many batch targets a card lists before "…and N more."
export const ACTION_TARGET_DISPLAY_CAP = 8;

export function actionConfirmDescription(
  kind: string,
  count: number,
  audience: "sme" | "console",
): string {
  const s = count === 1 ? "" : "s";
  if (kind === "draft_chasers") {
    const reviewer =
      audience === "sme"
        ? "for you to review, copy and send yourself"
        : "for the client to review and send";
    return `This drafts ${count} payment reminder${s} ${reviewer} — nothing is sent or submitted by the platform. Each invoice is re-checked at this moment, and the decision is recorded under your name.`;
  }
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

/**
 * The "…and N more." note under a target list capped at
 * ACTION_TARGET_DISPLAY_CAP. Call sites keep the
 * `targets.length > ACTION_TARGET_DISPLAY_CAP` conditional — this builder
 * only phrases the overflow.
 */
export function actionTargetOverflowNote(targetsLength: number): string {
  return `…and ${targetsLength - ACTION_TARGET_DISPLAY_CAP} more.`;
}

/**
 * The server-truncated-batch note: a capped batch must never read as the
 * whole backlog, so the copy says what is shown and what to do next.
 */
export function actionTruncatedNote(
  shown: number,
  targetCount: number,
): string {
  return `Showing the oldest ${shown} of ${targetCount} — approve this batch, then come back for the rest.`;
}

// The pinned clipboard contract for a transient chaser draft.
export function draftClipboardText(d: {
  subject: string;
  body: string;
}): string {
  return `${d.subject}\n\n${d.body}`;
}

// ---- Standing approvals (round 28) -----------------------------------------

// The automatable subset of the action catalogue (GrantActionPolicyInput's
// enum): draft_chasers is excluded by design — its drafts exist only on the
// response for a human to read and send, which an unattended run cannot do.
// Both cards use this to decide which proposals carry an "automate" button.
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

// Keyed by the automatable kinds (GrantActionPolicyInput's enum). A kind an
// older client does not know renders through the fallback in
// policyKindLabel, never as a blank.
export const POLICY_KIND_LABELS: Record<string, string> = {
  submit_overdue: "Auto-submit overdue invoices",
  retry_failed: "Auto-retry failed submissions",
};

export function policyKindLabel(kind: string): string {
  return POLICY_KIND_LABELS[kind] ?? kind;
}

// Why a grant is paused, in card-sized words. The three tripwire reasons are
// the sweep's own vocabulary (modules/clerk/action-policies.ts); "manual"
// is a human pause.
export const POLICY_PAUSE_REASON_LABELS: Record<string, string> = {
  manual: "paused manually",
  grantor_inactive: "paused — the granter's access changed",
  consent_missing: "paused — compliance consent is missing",
  failed_targets: "paused — too many failures in the last run",
  unknown_kind: "paused — this action kind can't run automatically",
  rail_rejections: "paused — the last run's submissions were rejected by the rails",
  engagement_closed: "paused — the engagement with this client has ended",
  run_error: "paused — the last run hit an unexpected error",
};

export function policyPauseReasonLabel(reason: string | null): string {
  return (
    POLICY_PAUSE_REASON_LABELS[reason ?? "manual"] ??
    `paused — ${reason}`
  );
}

// The per-run ceiling on a grant (GrantActionPolicyInput.maxTargetsPerRun,
// 1..50 on the contract) and the cards' shared default. parsePolicyCap is
// the one gate both grant dialogs run the raw input through: anything
// outside the contract's bounds means "not grantable yet" (the confirm
// button disables) — never a silent clamp the user didn't choose.
export const POLICY_CAP_MIN = 1;
export const POLICY_CAP_MAX = 50;
export const POLICY_CAP_DEFAULT = 10;

export function parsePolicyCap(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= POLICY_CAP_MIN && n <= POLICY_CAP_MAX ? n : null;
}

/**
 * The consent-grade description under the "automate" button: what a standing
 * approval DOES — including the per-run ceiling the user chose, so the copy
 * states the number being consented to — in the same honest register as the
 * per-batch confirm copy. The audience split mirrors
 * actionConfirmDescription's.
 */
export function policyGrantDescription(
  kind: string,
  audience: "sme" | "console",
  maxTargetsPerRun: number,
): string {
  const s = maxTargetsPerRun === 1 ? "" : "s";
  const what =
    kind === "retry_failed"
      ? `resubmit up to ${maxTargetsPerRun} invoice${s} that failed on the rails`
      : `submit up to ${maxTargetsPerRun} invoice${s} past the statutory window`;
  const who =
    audience === "sme"
      ? "under your name, without asking again each day"
      : "under your name, without a fresh approval each day";
  return (
    `Clerk will run this check every day and ${what} ${who}. ` +
    `Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.`
  );
}

// ---- Automation evidence (Prove with Clerk phase 2) ------------------------
// The client's OWN backtest, phrased for the grant surfaces: the consent
// dialogs lead with what the last six months actually looked like, so the
// standing approval is granted against evidence, not vibes. Honest-copy
// doctrine: no line at all from an empty sample (never a rate from nothing),
// low agreement renders as plainly as high (the numbers ARE the copy — no
// figure is invented here), and the line never gates the grant buttons.

// "N day(s)" — the median clauses' shared unit phrasing.
function medianDaysPhrase(days: number): string {
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The evidence sentence ABOVE a per-kind standing-approval consent (the
 * "Automate daily" dialogs, both audiences — "your own record" reads as the
 * client's whichever screen shows it). Null when there is no evidence or the
 * sample is empty: the call site renders nothing, not a placeholder. The
 * median clause appears only when the backtest could compute one.
 */
export function policyEvidenceLine(
  kind: "submit_overdue" | "retry_failed",
  ev?: { sample: number; agreed: number; medianLeadDays: number | null } | null,
): string | null {
  if (!ev || ev.sample === 0) return null;
  if (kind === "submit_overdue") {
    const median =
      ev.medianLeadDays !== null
        ? `, a median ${medianDaysPhrase(ev.medianLeadDays)} late`
        : "";
    return `Your own record, last 6 months: you eventually submitted ${ev.agreed} of ${ev.sample} such invoice${ev.sample === 1 ? "" : "s"} yourself${median}.`;
  }
  const median =
    ev.medianLeadDays !== null
      ? `, after a median ${medianDaysPhrase(ev.medianLeadDays)}`
      : "";
  return `Your own record, last 6 months: ${ev.agreed} of ${ev.sample} failed submission${ev.sample === 1 ? "" : "s"} ${ev.agreed === 1 ? "was" : "were"} eventually retried by hand${median}.`;
}

/**
 * The evidence sentence ABOVE the monthly plan-policy consent (the "Run
 * month-end close monthly" dialog): the plan's three steps composed into one
 * sentence, in the fixed submit_overdue / retry_failed / draft_recurring
 * order, keeping only the kinds with a non-empty sample. The median clauses
 * mirror the per-kind lines' (submit/recurring read "late", retry reads
 * "after"). Null when every listed kind has an empty sample — an evidence-free
 * dialog shows no evidence line, not an empty one.
 */
export function planEvidenceLine(
  kinds: Array<{
    kind: string;
    sample: number;
    agreed: number;
    medianLeadDays: number | null;
  }>,
): string | null {
  const segments: string[] = [];
  const submit = kinds.find((k) => k.kind === "submit_overdue");
  if (submit && submit.sample > 0) {
    const median =
      submit.medianLeadDays !== null
        ? `, a median ${medianDaysPhrase(submit.medianLeadDays)} late`
        : "";
    segments.push(
      `submitted ${submit.agreed} of ${submit.sample} overdue invoice${submit.sample === 1 ? "" : "s"} by hand${median}`,
    );
  }
  const retry = kinds.find((k) => k.kind === "retry_failed");
  if (retry && retry.sample > 0) {
    const median =
      retry.medianLeadDays !== null
        ? `, after a median ${medianDaysPhrase(retry.medianLeadDays)}`
        : "";
    segments.push(
      `retried ${retry.agreed} of ${retry.sample} failed submission${retry.sample === 1 ? "" : "s"}${median}`,
    );
  }
  const recurring = kinds.find((k) => k.kind === "draft_recurring");
  if (recurring && recurring.sample > 0) {
    const median =
      recurring.medianLeadDays !== null
        ? `, a median ${medianDaysPhrase(recurring.medianLeadDays)} late`
        : "";
    segments.push(
      `raised ${recurring.agreed} of ${recurring.sample} missing recurring invoice${recurring.sample === 1 ? "" : "s"}${median}`,
    );
  }
  if (segments.length === 0) return null;
  return `Your own record, last 6 months: ${segments.join("; ")}.`;
}
