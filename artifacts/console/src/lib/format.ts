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

export function statusTone(status: string): StatusTone {
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

// ---- Deadline severity -----------------------------------------------------

export function severityLabel(severity: string): string {
  return humanize(severity);
}

export function severityBadgeClasses(severity: string): string {
  switch (severity) {
    case "critical":
      return pillClasses("red");
    case "warning":
      return pillClasses("amber");
    case "info":
      return pillClasses("blue");
    default:
      return pillClasses("slate");
  }
}

// ---- Penalty risk (portfolio) ----------------------------------------------

export function riskLabel(risk: string): string {
  return `${humanize(risk)} risk`;
}

export function riskBadgeClasses(risk: string): string {
  switch (risk) {
    case "high":
      return pillClasses("red");
    case "medium":
      return pillClasses("amber");
    case "low":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

// ---- Case priority / gap severity (operator queue, advisory) ---------------

export function priorityBadgeClasses(priority: string): string {
  switch (priority) {
    case "high":
      return pillClasses("red");
    case "medium":
      return pillClasses("amber");
    default:
      return pillClasses("slate");
  }
}

// ---- CPD enrollment (certification) ----------------------------------------

export function enrollmentLabel(status: string): string {
  switch (status) {
    case "enrolled":
      return "Enrolled";
    case "completed":
      return "Completed";
    default:
      return humanize(status);
  }
}

export function enrollmentBadgeClasses(status: string): string {
  switch (status) {
    case "completed":
      return pillClasses("emerald");
    case "enrolled":
      return pillClasses("amber");
    default:
      return pillClasses("slate");
  }
}

// ---- Message deliveries (platform ops) --------------------------------------

export function messageStatusLabel(status: string): string {
  return humanize(status);
}

export function messageBadgeClasses(status: string): string {
  switch (status) {
    case "delivered":
      return pillClasses("emerald");
    case "failed":
      return pillClasses("red");
    case "sent":
      return pillClasses("blue");
    default:
      return pillClasses("slate");
  }
}

// ---- Rail circuit breaker (platform ops) ------------------------------------
// closed = healthy, half_open = probing after a trip, open = failing fast.

export function railStateLabel(state: string): string {
  switch (state) {
    case "open":
      return "Circuit open";
    case "half_open":
      return "Half-open (probing)";
    case "closed":
      return "Healthy";
    default:
      return humanize(state);
  }
}

export function railBadgeClasses(state: string): string {
  switch (state) {
    case "open":
      return pillClasses("red");
    case "half_open":
      return pillClasses("amber");
    case "closed":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

// ---- ERP connections (integrations) ------------------------------------------

export function connectionBadgeClasses(status: string): string {
  switch (status) {
    case "active":
      return pillClasses("emerald");
    case "error":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// ---- Client import rows -------------------------------------------------------

export function importRowLabel(status: string): string {
  switch (status) {
    case "created":
      return "Created";
    case "exists":
      return "Already exists";
    case "invalid":
      return "Invalid";
    default:
      return humanize(status);
  }
}

export function importRowBadgeClasses(status: string): string {
  switch (status) {
    case "created":
      return pillClasses("emerald");
    case "exists":
      return pillClasses("amber");
    case "invalid":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// ---- Clerk case lifecycle (clerk workspace) ---------------------------------
// Amber = waiting on a human, green = cleared for the next hop, red = stopped.

export function clerkCaseStateLabel(state: string): string {
  switch (state) {
    case "ready_for_review":
      return "Needs review";
    case "clarification_required":
      return "Clarification required";
    case "awaiting_submission_approval":
      return "Approved — awaiting submission";
    default:
      return humanize(state);
  }
}

export function clerkCaseStateBadgeClasses(state: string): string {
  switch (state) {
    case "ready_for_review":
    case "clarification_required":
      return pillClasses("amber");
    case "approved":
    case "validated":
    case "awaiting_submission_approval":
      return pillClasses("emerald");
    case "escalated":
    case "rejected":
      return pillClasses("red");
    // refused / closed / intake states fall back to neutral.
    default:
      return pillClasses("slate");
  }
}

/** States the case machine can still move out of on its own. */
export function isClerkCaseTerminal(state: string): boolean {
  return state === "closed" || state === "rejected" || state === "refused";
}

// ---- Claim records (claims register) -----------------------------------------

export function claimStatusBadgeClasses(status: string): string {
  switch (status) {
    case "review":
      return pillClasses("amber");
    case "active":
      return pillClasses("emerald");
    case "suspended":
      return pillClasses("red");
    // draft, superseded, expired, rejected read as muted history.
    default:
      return pillClasses("slate");
  }
}

// ---- Clerk extraction confidence ----------------------------------------------
// CLK-AI-05 routing bands: ≥0.90 auto-proposable, ≥0.75 review, below = suspect.

export function clerkConfidenceBadgeClasses(confidence: number): string {
  if (confidence >= 0.9) return pillClasses("emerald");
  if (confidence >= 0.75) return pillClasses("amber");
  return pillClasses("red");
}

export function clerkRunOutcomeBadgeClasses(outcome: string): string {
  switch (outcome) {
    case "allowed":
      return pillClasses("emerald");
    case "refused":
      return pillClasses("amber");
    case "blocked":
    case "error":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// ---- Assessment bands (advisory) ---------------------------------------------

export function bandLabel(band: string): string {
  return humanize(band);
}

export function bandBadgeClasses(band: string): string {
  switch (band) {
    case "ready":
      return pillClasses("emerald");
    case "partial":
      return pillClasses("amber");
    default:
      return pillClasses("red");
  }
}
