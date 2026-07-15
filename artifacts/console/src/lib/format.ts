// Shared formatters, the pill design language and the invoice-lifecycle /
// deadline-severity helpers live in the workspace package; this module keeps
// only the console-specific badge vocabularies, as data-driven maps with the
// same fallbacks the old switches had.
export * from "@workspace/format";

import { humanize, pillClasses, type BadgeTone } from "@workspace/format";

const toneOr = (
  tones: Record<string, BadgeTone>,
  key: string,
  fallback: BadgeTone,
): string => pillClasses(tones[key] ?? fallback);

const labelOr = (labels: Record<string, string>, key: string): string =>
  labels[key] ?? humanize(key);

// ---- Penalty risk (portfolio) ----------------------------------------------

const RISK_TONES: Record<string, BadgeTone> = {
  high: "red",
  medium: "amber",
  low: "emerald",
};

export function riskLabel(risk: string): string {
  return `${humanize(risk)} risk`;
}

export function riskBadgeClasses(risk: string): string {
  return toneOr(RISK_TONES, risk, "slate");
}

// ---- Case priority / gap severity (operator queue, advisory) ---------------

const PRIORITY_TONES: Record<string, BadgeTone> = {
  high: "red",
  medium: "amber",
};

export function priorityBadgeClasses(priority: string): string {
  return toneOr(PRIORITY_TONES, priority, "slate");
}

// ---- CPD enrollment (certification) ----------------------------------------

const ENROLLMENT_LABELS: Record<string, string> = {
  enrolled: "Enrolled",
  completed: "Completed",
};

const ENROLLMENT_TONES: Record<string, BadgeTone> = {
  completed: "emerald",
  enrolled: "amber",
};

export function enrollmentLabel(status: string): string {
  return labelOr(ENROLLMENT_LABELS, status);
}

export function enrollmentBadgeClasses(status: string): string {
  return toneOr(ENROLLMENT_TONES, status, "slate");
}

// ---- Message deliveries (platform ops) --------------------------------------

const MESSAGE_TONES: Record<string, BadgeTone> = {
  delivered: "emerald",
  failed: "red",
  sent: "blue",
};

export function messageStatusLabel(status: string): string {
  return humanize(status);
}

export function messageBadgeClasses(status: string): string {
  return toneOr(MESSAGE_TONES, status, "slate");
}

// ---- Rail circuit breaker (platform ops) ------------------------------------
// closed = healthy, half_open = probing after a trip, open = failing fast.

const RAIL_LABELS: Record<string, string> = {
  open: "Circuit open",
  half_open: "Half-open (probing)",
  closed: "Healthy",
};

const RAIL_TONES: Record<string, BadgeTone> = {
  open: "red",
  half_open: "amber",
  closed: "emerald",
};

export function railStateLabel(state: string): string {
  return labelOr(RAIL_LABELS, state);
}

export function railBadgeClasses(state: string): string {
  return toneOr(RAIL_TONES, state, "slate");
}

// ---- ERP connections (integrations) ------------------------------------------

const CONNECTION_TONES: Record<string, BadgeTone> = {
  active: "emerald",
  error: "red",
};

export function connectionBadgeClasses(status: string): string {
  return toneOr(CONNECTION_TONES, status, "slate");
}

// ---- Client import rows -------------------------------------------------------

const IMPORT_ROW_LABELS: Record<string, string> = {
  created: "Created",
  exists: "Already exists",
  invalid: "Invalid",
};

const IMPORT_ROW_TONES: Record<string, BadgeTone> = {
  created: "emerald",
  exists: "amber",
  invalid: "red",
};

export function importRowLabel(status: string): string {
  return labelOr(IMPORT_ROW_LABELS, status);
}

export function importRowBadgeClasses(status: string): string {
  return toneOr(IMPORT_ROW_TONES, status, "slate");
}

// ---- Assessment bands (advisory) ---------------------------------------------

const BAND_TONES: Record<string, BadgeTone> = {
  ready: "emerald",
  partial: "amber",
};

export function bandLabel(band: string): string {
  return humanize(band);
}

export function bandBadgeClasses(band: string): string {
  // Anything that isn't ready/partial reads as a red not-ready band.
  return toneOr(BAND_TONES, band, "red");
}
