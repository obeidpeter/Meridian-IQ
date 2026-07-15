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
