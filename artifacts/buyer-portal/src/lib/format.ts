export function formatNaira(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    minimumFractionDigits: 2,
  }).format(n);
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
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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

function statusTone(status: string): StatusTone {
  if (status === "draft" || status === "validated") return "draft";
  if (status === "submitted") return "pending";
  if (status === "stamped" || status === "confirmed") return "stamped";
  if (status === "settled") return "settled";
  if (status === "credited") return "credited";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  // Unknown statuses fall back to slate with the humanized raw label.
  return "unknown";
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

// ---- Buyer rails: confirmation-state tones -------------------------------

export function confirmationLabel(state: string): string {
  switch (state) {
    case "requested":
      return "Awaiting response";
    case "confirmed":
      return "Confirmed";
    case "queried":
      return "Queried";
    case "rejected":
      return "Rejected";
    case "none":
      return "Not requested";
    default:
      return humanize(state);
  }
}

export function confirmationBadgeClasses(state: string): string {
  switch (state) {
    case "requested":
      return pillClasses("amber");
    case "confirmed":
      return pillClasses("emerald");
    case "queried":
      return pillClasses("blue");
    case "rejected":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// ---- Buyer rails: boolean stamp / eligibility pills ------------------------
// One home for the wording pairs so "No stamp" / "VAT eligible" read the same
// on the queue and on the invoice detail page.

export function stampBadge(stampValid: boolean | null | undefined): {
  label: string;
  classes: string;
} {
  return stampValid
    ? { label: "Stamp valid", classes: pillClasses("emerald") }
    : { label: "No stamp", classes: pillClasses("slate") };
}

export function eligibleBadge(eligible: boolean | null | undefined): {
  label: string;
  classes: string;
} {
  return eligible
    ? { label: "VAT eligible", classes: pillClasses("emerald") }
    : { label: "Not eligible", classes: pillClasses("amber") };
}
