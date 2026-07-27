// Shared formatters, the pill design language and the invoice-lifecycle /
// deadline-severity / confirmation helpers live in the workspace package;
// this module keeps only the SME-specific badge vocabularies.
export * from "@workspace/format";

import { humanize, pillClasses } from "@workspace/format";

// ---- B2C reporting batches -------------------------------------------------

export function batchStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Awaiting report";
    case "reported":
      return "Reported";
    case "breached":
      return "Deadline missed";
    default:
      return humanize(status);
  }
}

export function batchBadgeClasses(status: string): string {
  switch (status) {
    case "open":
      return pillClasses("amber");
    case "reported":
      return pillClasses("emerald");
    case "breached":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// ---- Bank statements & match proposals ------------------------------------

export function statementStatusLabel(status: string): string {
  switch (status) {
    case "validated":
      return "Validated";
    case "committed":
      return "Matching in progress";
    case "reconciled":
      return "Reconciled";
    default:
      return humanize(status);
  }
}

export function statementBadgeClasses(status: string): string {
  switch (status) {
    case "validated":
      return pillClasses("blue");
    case "committed":
      return pillClasses("amber");
    case "reconciled":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

export function proposalStatusLabel(status: string): string {
  switch (status) {
    case "proposed":
      return "Proposed";
    case "accepted":
      return "Accepted";
    case "rejected":
      return "Rejected";
    case "superseded":
      return "Superseded";
    default:
      return humanize(status);
  }
}

export function proposalBadgeClasses(status: string): string {
  switch (status) {
    case "proposed":
      return pillClasses("blue");
    case "accepted":
      return pillClasses("emerald");
    case "rejected":
      return pillClasses("red");
    default:
      return pillClasses("slate");
  }
}

// Greener as confidence rises so the strongest matches stand out at a glance.
export function confidenceBadgeClasses(confidence: string | number): string {
  const n = Number(confidence);
  if (n >= 0.9) return pillClasses("emerald");
  if (n >= 0.7) return pillClasses("teal");
  if (n >= 0.5) return pillClasses("amber");
  return pillClasses("red");
}

// ---- Supplier bills (payables) --------------------------------------------

export function billPayStatusLabel(payStatus: string): string {
  switch (payStatus) {
    case "open":
      return "Unpaid";
    case "scheduled":
      return "Scheduled";
    case "paid":
      return "Paid";
    default:
      return humanize(payStatus);
  }
}

export function billPayStatusBadgeClasses(payStatus: string): string {
  switch (payStatus) {
    case "scheduled":
      return pillClasses("amber");
    case "paid":
      return pillClasses("emerald");
    default:
      return pillClasses("slate");
  }
}

/**
 * Payment flags record settlement evidence on a bill (they never edit the
 * document): "paid" is terminal — no further flags — and re-flagging
 * "scheduled" over itself is a no-op the UI shouldn't offer. Off-contract
 * statuses from a newer server stay flaggable rather than dead-ending.
 */
export function canFlagBill(
  payStatus: string,
  target: "scheduled" | "paid",
): boolean {
  if (payStatus === "paid") return false;
  if (target === "scheduled") return payStatus !== "scheduled";
  return true;
}
