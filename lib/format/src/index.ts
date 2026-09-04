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

// The pause vocabulary lives in the import-free ./action-copy module (see
// the re-export further down); policyStatusLine below composes it with the
// Intl-backed formatDateTime.
import { policyPauseReasonLabel } from "./action-copy";
import {
  formatDateTime,
  humanize,
  pillClasses,
  type BadgeTone,
} from "./primitives";

export {
  formatDate,
  formatDateTime,
  humanize,
  pillClasses,
  type BadgeTone,
} from "./primitives";

// One public contact address across the landing, recovery and calculator
// surfaces. Its operational verification is tracked by Release Readiness.
export const ADVISORY_EMAIL = "advisory@meridianiq.com";

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

// Statutory deadlines are Lagos-midnight instants (the server's
// lib/lagos-time); rendering them in the viewer's zone shows the eve of the
// statutory day from anywhere west of WAT, and a wall-clock-ms countdown
// contradicts the printed date on the eve of every deadline. These twins pin
// display and day-arithmetic to Africa/Lagos (fixed UTC+1, no DST).
const LAGOS_DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Lagos",
});

// en-CA renders YYYY-MM-DD — the day key behind the calendar-day difference.
const LAGOS_DAY_KEY_FORMAT = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Africa/Lagos",
});

/** formatDate pinned to the Lagos (WAT) statutory calendar. */
export function formatLagosDate(
  value: string | Date | null | undefined,
): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return LAGOS_DATE_FORMAT.format(d);
}

/**
 * Whole Lagos calendar days from `from` (default: now) to `target`:
 * 0 = same Lagos day, negative = past. The difference is between Lagos
 * DATES, never wall-clock hours, so a countdown built on it can never
 * contradict the printed statutory day.
 */
export function lagosDayDiff(
  target: string | Date | null | undefined,
  from: Date = new Date(),
): number | null {
  if (!target) return null;
  const d = new Date(target);
  if (Number.isNaN(d.getTime())) return null;
  const toUtcDay = (x: Date) => {
    const [y, m, day] = LAGOS_DAY_KEY_FORMAT.format(x).split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.round((toUtcDay(d) - toUtcDay(from)) / 86_400_000);
}

// ---- Status pills (design language §8) -----------------------------------
// The single home for tone maps and the pill recipe. Every tone ships both
// light and dark classes so flipping `.dark` never breaks a badge.

/**
 * Borderless summary pill for a card-HEADER count ("3 to review",
 * "1 paused", "All clear") — softer than the bordered status pill, same
 * light+dark discipline. Distinct recipe from pillClasses. Two literal
 * strings (never a template over the tone) so the Tailwind scanner sees
 * every class; call sites keep their own positioning prefix ("ml-auto ").
 */
export function summaryPillClasses(tone: "amber" | "emerald"): string {
  return tone === "amber"
    ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
    : "rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
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
  return (
    (STATUS_TONES as Partial<Record<string, StatusTone>>)[status] ?? "unknown"
  );
}

export function statusLabel(status: string): string {
  const tone = statusTone(status);
  if (tone === "draft") return status === "validated" ? "Validated" : "Draft";
  if (tone === "pending") return "Awaiting stamp";
  if (tone === "stamped")
    return status === "confirmed" ? "Confirmed" : "Stamped";
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

// ---- Stamp identifier vocabulary -------------------------------------------
// First-use expansions of the two FIRS stamp identifiers, shared so the
// wording cannot drift between the SME stamp card, the bills verify form and
// the marketing site. Every surface expands the acronym at its first use
// (the TIN precedent), then may use the short form.
export const IRN_EXPANSION = "Invoice Reference Number";
export const CSID_EXPANSION = "Cryptographic Stamp ID";

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
    (CONFIRMATION_TONES as Partial<Record<string, BadgeTone>>)[state] ??
      "slate",
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
// verbatim, and the standing-approval (round 28) vocabulary: the wording
// lives in ./action-copy — an import-free module also exported as the
// "@workspace/format/action-copy" subpath so the mobile app can share it
// without this file's module-load Intl construction (RN's ICU builds are
// inconsistent). Only the builders needing formatDateTime live below.
export * from "./action-copy";

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
 * One line per recorded decision in the run-record strip both cards render:
 * date, kind, the three counts, and the "· auto" tag when a
 * standing-approval run (not a fresh click) made it.
 */
export function decisionLine(decision: {
  createdAt: string;
  kind: string;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  policyId: string | null;
}): string {
  return `${formatDateTime(decision.createdAt)} · ${decision.kind} · ${decision.executedCount} executed · ${decision.skippedCount} skipped · ${decision.failedCount} failed${decision.policyId ? " · auto" : ""}`;
}

// ---- Notification bell vocabulary -----------------------------------------
// Channel labels/tones, relative-time buckets and the badge/mark-read
// helpers shared by the console and SME notification bells.

export * from "./notifications";

// ---- Role vocabulary ------------------------------------------------------

/**
 * Display labels for principal roles — the one home shared by the console
 * shell, and the SME / buyer wrong-workspace cards, so a renamed role
 * cannot drift between apps.
 */
export function roleLabel(role: string | undefined): string {
  return (
    {
      firm_admin: "Firm admin",
      firm_staff: "Firm staff",
      client_user: "Client user",
      operator: "Operator",
      buyer_user: "Buyer",
      auditor: "Auditor",
    }[role ?? ""] ??
    (role || "Unknown role")
  );
}

/**
 * The workspace a role calls home — mirrors the portal's DEFAULT_WORKSPACE
 * so the wrong-workspace cards can deep-link a lost visitor to a place they
 * can actually use instead of only bouncing them through the portal.
 */
export function roleHomeHref(
  role: string | undefined,
): { href: string; label: string } | null {
  return (
    {
      firm_admin: { href: "/console/", label: "the Accountant Console" },
      firm_staff: { href: "/app/", label: "the Compliance App" },
      client_user: { href: "/app/", label: "the Compliance App" },
      operator: {
        href: "/console/operator-queue",
        label: "the Operator queue",
      },
      buyer_user: { href: "/buyer/", label: "Buyer Rails" },
      auditor: { href: "/console/audit", label: "Audit & evidence" },
    }[role ?? ""] ?? null
  );
}

// ---- Ask history ------------------------------------------------------------

/** The shape of a stored question case the Ask pages list as history. */
export interface QuestionCaseLike {
  id: string;
  kind: string;
  question?: string | null;
  answer?: unknown;
  createdAt: string;
}

/**
 * The rows an Ask page lists under "Recent questions": answered question
 * cases only (an unanswered or refused case has nothing to reopen), newest
 * first, capped so the list stays a shortlist. Pure so both apps share one
 * ordering and cap.
 */
export function recentQuestionRows<T extends QuestionCaseLike>(
  cases: readonly T[],
  limit = 5,
): T[] {
  return cases
    .filter((c) => c.kind === "question" && !!c.answer && !!c.question)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}
