// Shared formatters, the pill design language and the invoice-lifecycle /
// deadline-severity helpers live in the workspace package; this module keeps
// only the console-specific badge vocabularies.
export * from "@workspace/format";

import { humanize, pillClasses } from "@workspace/format";

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
