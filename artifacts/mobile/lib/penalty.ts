/**
 * MeridianIQ offline penalty estimator — calculation core.
 *
 * Subset of the calculation core ported from the public penalty-calculator web
 * artifact (`artifacts/penalty-calculator/src/lib/penalty.ts`): only the
 * pieces the offline estimator uses (s.103/s.104 per-section penalties,
 * constants, formatting, and the estimator's option lists). For
 * turnover-to-band classification or the combined `calculatePenalty` entry
 * point, port from the source artifact, which has tests. Everything here runs
 * entirely offline: no network, no persistence, no PII.
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

import { formatCurrency } from "./format";

export type TurnoverBand = "small" | "medium" | "large";

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

/** Coerce arbitrary input into a finite, non-negative number. */
function toNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** Coerce input into a non-negative integer (whole days / invoices). */
function toCount(value: number): number {
  return Math.floor(toNonNegative(value));
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

/**
 * Format a Naira amount for display, e.g. ₦1,075,000.
 *
 * We format manually (₦ symbol + grouped integer) rather than relying on
 * Intl currency formatting, which is inconsistent across React Native's
 * Hermes/JSC ICU builds.
 */
export function formatNaira(amount: number): string {
  return formatCurrency(Math.round(toNonNegative(amount)));
}

export const BAND_THRESHOLDS: Record<TurnoverBand, string> = {
  small: "Turnover up to \u20A625,000,000",
  medium: "Turnover \u20A625,000,001 \u2013 \u20A6100,000,000",
  large: "Turnover above \u20A6100,000,000",
};

export interface TurnoverBandOption {
  band: TurnoverBand;
  label: string;
  threshold: string;
}

/** Selectable turnover bands for the estimator UI. */
export const TURNOVER_BAND_OPTIONS: TurnoverBandOption[] = [
  { band: "small", label: "Small", threshold: BAND_THRESHOLDS.small },
  { band: "medium", label: "Medium", threshold: BAND_THRESHOLDS.medium },
  { band: "large", label: "Large", threshold: BAND_THRESHOLDS.large },
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
