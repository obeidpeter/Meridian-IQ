// Shared display formatting for the three web apps (console, SME, buyer
// portal): generic formatters (currency/percent/date — shared even where only
// one app uses them today), the status-pill design language, and the badge
// vocabularies rendered by two or more apps. Badge vocabularies with a single
// consuming app stay in that app's src/lib/format.ts, which re-exports this
// module so pages keep importing from "@/lib/format".

// Type-only: keys the vocabulary maps below to the contract's enums so a new
// status added to openapi.yaml fails typecheck here instead of silently
// rendering as a grey humanized pill in three apps. Erased at compile time.
import type {
  ActionTargetOutcomeOutcome,
  ComplianceDeadlineSeverity,
  ConfirmationState,
  InvoiceStatus,
} from "@workspace/api-zod";

// Intl formatter construction is expensive (locale-data setup) and these run
// per table row per render — build each once at module load.
const NAIRA_FORMAT = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  minimumFractionDigits: 2,
});

const COMPACT_NAIRA_FORMAT = new Intl.NumberFormat("en-NG", {
  style: "currency",
  currency: "NGN",
  notation: "compact",
  maximumFractionDigits: 1,
});

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatNaira(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return NAIRA_FORMAT.format(n);
}

// Non-NGN amounts: a plain grouped number plus the currency code, so a
// foreign-currency figure never masquerades as naira (the portfolio
// rollup's idiom, shared since round 20's currency-aware miners).
const FOREIGN_AMOUNT_FORMAT = new Intl.NumberFormat("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Currency-aware amount: NGN renders as naira, anything else as "1,200.00 USD". */
export function formatAmount(
  value: string | number | null | undefined,
  currency: string,
): string {
  if (currency === "NGN") return formatNaira(value);
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `${FOREIGN_AMOUNT_FORMAT.format(n)} ${currency}`;
}

/**
 * Compact stat-card variant: "₦1.2M". Pair it with the full value in the
 * element's `title` attribute so the exact figure is always reachable.
 */
export function formatCompactNaira(
  value: string | number | null | undefined,
): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return COMPACT_NAIRA_FORMAT.format(n);
}

/**
 * Fraction to percent: 0.075 → "7.5%". digits=0 matches Math.round for the
 * non-negative rate domain these pages format.
 */
export function formatPct(
  value: string | number | null | undefined,
  digits = 1,
): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_FORMAT.format(d);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return DATE_TIME_FORMAT.format(d);
}

/** Humanize a raw enum value: "buyer_flag" → "Buyer flag". */
export function humanize(raw: string | null | undefined): string {
  const s = (raw ?? "").replace(/[_-]+/g, " ").trim();
  if (!s) return "Unknown";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- Status pills (design language §8) -----------------------------------
// The single home for tone maps and the pill recipe. Every tone ships both
// light and dark classes so flipping `.dark` never breaks a badge.

export type BadgeTone =
  | "emerald"
  | "teal"
  | "violet"
  | "amber"
  | "blue"
  | "red"
  | "slate";

const PILL =
  "inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full border";

const TONE_CLASSES: Record<BadgeTone, string> = {
  emerald:
    "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-900",
  teal: "bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:border-teal-900",
  violet:
    "bg-violet-100 text-violet-800 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-900",
  amber:
    "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-900",
  blue: "bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-900",
  red: "bg-red-100 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-900",
  slate:
    "bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800",
};

/** Full pill class string for a tone: recipe + colors. */
export function pillClasses(tone: BadgeTone): string {
  return `${PILL} ${TONE_CLASSES[tone]}`;
}

// ---- Invoice lifecycle -----------------------------------------------------

type StatusTone =
  | "draft"
  | "pending"
  | "stamped"
  | "settled"
  | "credited"
  | "failed"
  | "cancelled"
  | "unknown";

// Exhaustive over the contract's InvoiceStatus (typecheck fails on a new
// status until it is mapped here).
const STATUS_TONES: Record<InvoiceStatus, StatusTone> = {
  draft: "draft",
  validated: "draft",
  submitted: "pending",
  stamped: "stamped",
  confirmed: "stamped",
  settled: "settled",
  credited: "credited",
  failed: "failed",
  cancelled: "cancelled",
};

export function statusTone(status: string): StatusTone {
  // Off-contract statuses (version skew) fall back to slate with the
  // humanized raw label.
  return (STATUS_TONES as Partial<Record<string, StatusTone>>)[status] ?? "unknown";
}

export function statusLabel(status: string): string {
  const tone = statusTone(status);
  if (tone === "draft") return status === "validated" ? "Validated" : "Draft";
  if (tone === "pending") return "Pending stamp";
  if (tone === "stamped") return status === "confirmed" ? "Confirmed" : "Stamped";
  if (tone === "settled") return "Settled";
  if (tone === "credited") return "Credited";
  if (tone === "failed") return "Failed";
  if (tone === "cancelled") return "Cancelled";
  return humanize(status);
}

export function badgeClasses(status: string): string {
  switch (statusTone(status)) {
    case "stamped":
      return pillClasses("emerald");
    case "settled":
      return pillClasses("teal");
    case "credited":
      return pillClasses("violet");
    case "pending":
      return pillClasses("amber");
    case "failed":
      return pillClasses("red");
    case "cancelled":
    case "unknown":
      return pillClasses("slate");
    default:
      return pillClasses("blue");
  }
}

// ---- Deadline severity -----------------------------------------------------

export function severityLabel(severity: string): string {
  return humanize(severity);
}

// Exhaustive over the contract's ComplianceDeadlineSeverity.
const SEVERITY_TONES: Record<ComplianceDeadlineSeverity, BadgeTone> = {
  critical: "red",
  warning: "amber",
  info: "blue",
};

export function severityBadgeClasses(severity: string): string {
  return pillClasses(
    (SEVERITY_TONES as Partial<Record<string, BadgeTone>>)[severity] ?? "slate",
  );
}

// ---- Buyer rails: confirmation-state tones -------------------------------

// Exhaustive over the contract's ConfirmationState, plus the synthetic "none"
// the invoice pages render before any confirmation exists.
const CONFIRMATION_LABELS: Record<ConfirmationState | "none", string> = {
  requested: "Awaiting response",
  confirmed: "Confirmed",
  queried: "Queried",
  rejected: "Rejected",
  none: "Not requested",
};

const CONFIRMATION_TONES: Record<ConfirmationState | "none", BadgeTone> = {
  requested: "amber",
  confirmed: "emerald",
  queried: "blue",
  rejected: "red",
  none: "slate",
};

export function confirmationLabel(state: string): string {
  return (
    (CONFIRMATION_LABELS as Partial<Record<string, string>>)[state] ??
    humanize(state)
  );
}

export function confirmationBadgeClasses(state: string): string {
  return pillClasses(
    (CONFIRMATION_TONES as Partial<Record<string, BadgeTone>>)[state] ?? "slate",
  );
}

// ---- Action batch outcomes -------------------------------------------------
// Per-target outcomes of an approved Clerk action batch, rendered identically
// by the SME dashboard's "Clerk suggests" card and its console twin.

// Exhaustive over the contract's ActionTargetOutcomeOutcome (typecheck fails
// on a new outcome until it is mapped here).
export const ACTION_OUTCOME_LABELS: Record<ActionTargetOutcomeOutcome, string> =
  {
    submitted: "Submitted",
    invalid: "Needs fixing",
    skipped_not_eligible: "Skipped",
    failed: "Failed",
    drafted: "Drafted",
  };

/**
 * Inline text tone for a batch-outcome row (plain text, not a pill): emerald
 * for the two success outcomes, muted for not-eligible skips, amber for
 * anything needing attention — including off-contract outcomes from a newer
 * server, which read as "look at this" rather than silently default-grey.
 */
export function actionOutcomeToneClasses(outcome: string): string {
  if (outcome === "submitted" || outcome === "drafted")
    return "text-emerald-700 dark:text-emerald-400";
  if (outcome === "skipped_not_eligible") return "text-muted-foreground";
  return "text-amber-700 dark:text-amber-400";
}

// The approve/results dialog copy the two "Clerk suggests" cards render
// verbatim (survey items 25+26 — extracted with the headless machine in
// @workspace/web-ui). Pure builders so the exact wording has one home and
// unit tests; the SME/console texts differ ONLY where the audience does.

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

// The pinned clipboard contract for a transient chaser draft.
export function draftClipboardText(d: {
  subject: string;
  body: string;
}): string {
  return `${d.subject}\n\n${d.body}`;
}

// ---- Standing approvals (round 28) -----------------------------------------
// The automation strip both "Clerk suggests" cards render under a proposal:
// grant affordance, live-grant status line, pause/tripwire vocabulary, and
// the "· auto" tag on policy-run decision lines. Pure builders — one home
// for the exact wording, unit-tested in action-dialog-copy.test.ts.

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
};

export function policyPauseReasonLabel(reason: string | null): string {
  return (
    POLICY_PAUSE_REASON_LABELS[reason ?? "manual"] ??
    `paused — ${reason}`
  );
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

/**
 * The consent-grade description under the "automate" button: what a standing
 * approval DOES, in the same honest register as the per-batch confirm copy.
 * The audience split mirrors actionConfirmDescription's.
 */
export function policyGrantDescription(
  kind: string,
  audience: "sme" | "console",
): string {
  const what =
    kind === "retry_failed"
      ? "resubmit invoices that failed on the rails"
      : "submit invoices past the statutory window";
  const who =
    audience === "sme"
      ? "under your name, without asking again each day"
      : "under your name, without a fresh approval each day";
  return (
    `Clerk will run this check every day and ${what} ${who}. ` +
    `Every run re-checks consent, your access and each invoice; you can pause or revoke this at any time, and every run is recorded.`
  );
}

// ---- Notification bell vocabulary -----------------------------------------
// Channel labels/tones, relative-time buckets and the badge/mark-read
// helpers shared by the console and SME notification bells.

export * from "./notifications";
