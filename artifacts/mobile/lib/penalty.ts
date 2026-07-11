/**
 * MeridianIQ offline penalty estimator — pure calculation core.
 *
 * Ported from the public penalty-calculator web artifact
 * (`artifacts/penalty-calculator/src/lib/penalty.ts` + `deadlines.ts`) so the
 * mobile companion can estimate exposure entirely offline: no network, no
 * persistence, no PII.
 *
 *   s.103 — Failure to grant the tax authority access to fiscalisation
 *           systems/records. A fixed first-day charge (₦1,000,000) plus a
 *           daily charge (₦10,000) for every additional day.
 *
 *   s.104 — Failure to issue a compliant electronic (fiscalised) invoice.
 *           A per-invoice administrative charge scaled by the taxpayer's
 *           turnover band.
 *
 * The statutory instrument publishes no monetary figures, so the amounts
 * below are MeridianIQ's stated model — surfaced as an estimate, not advice.
 */

export type TurnoverBand = "small" | "medium" | "large";

/** Upper bound (inclusive, in Naira) of the "small" turnover band. */
export const SMALL_TURNOVER_CEILING = 25_000_000;
/** Upper bound (inclusive, in Naira) of the "medium" turnover band. */
export const MEDIUM_TURNOVER_CEILING = 100_000_000;

/** s.103 charge applied on the first day access is not granted. */
export const S103_FIRST_DAY = 1_000_000;
/** s.103 charge for each additional day the failure continues. */
export const S103_PER_ADDITIONAL_DAY = 10_000;

/** s.104 per-invoice charge, scaled by turnover band. */
export const S104_PER_INVOICE: Record<TurnoverBand, number> = {
  small: 25_000,
  medium: 50_000,
  large: 100_000,
};

export interface PenaltyInput {
  /** Annual turnover in Naira. */
  annualTurnover: number;
  /** Number of days access to systems/records was not granted (s.103). */
  daysAccessNotGranted: number;
  /** Count of non-compliant / unissued electronic invoices (s.104). */
  nonCompliantInvoiceCount: number;
}

export interface PenaltyResult {
  band: TurnoverBand;
  section103: number;
  section104: number;
  total: number;
}

/** Coerce arbitrary input into a finite, non-negative number. */
function toNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Coerce input into a non-negative integer (whole days / invoices). */
function toCount(value: number): number {
  return Math.floor(toNonNegative(value));
}

/** Classify annual turnover into a band. Negative/invalid maps to "small". */
export function classifyBand(annualTurnover: number): TurnoverBand {
  const turnover = toNonNegative(annualTurnover);
  if (turnover <= SMALL_TURNOVER_CEILING) return "small";
  if (turnover <= MEDIUM_TURNOVER_CEILING) return "medium";
  return "large";
}

/** s.103 exposure for a given number of days access was not granted. */
export function section103Penalty(daysAccessNotGranted: number): number {
  const days = toCount(daysAccessNotGranted);
  if (days <= 0) return 0;
  return S103_FIRST_DAY + S103_PER_ADDITIONAL_DAY * (days - 1);
}

/** s.104 exposure for a count of non-compliant invoices in a given band. */
export function section104Penalty(
  nonCompliantInvoiceCount: number,
  band: TurnoverBand,
): number {
  const count = toCount(nonCompliantInvoiceCount);
  if (count <= 0) return 0;
  return count * S104_PER_INVOICE[band];
}

/** Full estimate: band, both sections, and the combined total. */
export function calculatePenalty(input: PenaltyInput): PenaltyResult {
  const band = classifyBand(input.annualTurnover);
  const section103 = section103Penalty(input.daysAccessNotGranted);
  const section104 = section104Penalty(input.nonCompliantInvoiceCount, band);
  return { band, section103, section104, total: section103 + section104 };
}

/**
 * Format a Naira amount for display, e.g. ₦1,075,000.
 *
 * We format manually (₦ symbol + grouped integer) rather than relying on
 * Intl currency formatting, which is inconsistent across React Native's
 * Hermes/JSC ICU builds.
 */
export function formatNaira(amount: number): string {
  const safe = Math.round(toNonNegative(amount));
  const grouped = safe.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `\u20A6${grouped}`;
}

export const BAND_LABELS: Record<TurnoverBand, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export const BAND_THRESHOLDS: Record<TurnoverBand, string> = {
  small: "Turnover up to \u20A625,000,000",
  medium: "Turnover \u20A625,000,001 \u2013 \u20A6100,000,000",
  large: "Turnover above \u20A6100,000,000",
};

export interface TurnoverBandOption {
  band: TurnoverBand;
  label: string;
  threshold: string;
  /** Representative turnover value used to seed the estimate. */
  representativeTurnover: number;
}

/** Selectable turnover bands for the estimator UI. */
export const TURNOVER_BAND_OPTIONS: TurnoverBandOption[] = [
  {
    band: "small",
    label: "Small",
    threshold: BAND_THRESHOLDS.small,
    representativeTurnover: 10_000_000,
  },
  {
    band: "medium",
    label: "Medium",
    threshold: BAND_THRESHOLDS.medium,
    representativeTurnover: 60_000_000,
  },
  {
    band: "large",
    label: "Large",
    threshold: BAND_THRESHOLDS.large,
    representativeTurnover: 250_000_000,
  },
];

export type FilingType = "access" | "invoice" | "both";

export interface FilingTypeOption {
  value: FilingType;
  label: string;
  description: string;
}

/** The failure scenarios the estimator can model. */
export const FILING_TYPE_OPTIONS: FilingTypeOption[] = [
  {
    value: "access",
    label: "Systems access (s.103)",
    description: "Tax authority could not access fiscalisation systems/records.",
  },
  {
    value: "invoice",
    label: "Unissued e-invoices (s.104)",
    description: "Compliant electronic invoices were not issued.",
  },
  {
    value: "both",
    label: "Both failures",
    description: "Access was withheld and invoices were not fiscalised.",
  },
];
