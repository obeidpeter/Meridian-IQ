/**
 * Pure helpers behind the Reconciliation screen: the CSV size ceiling, the
 * status vocabularies for statements and match proposals, the bank-format
 * names, and the small display formatters. The screen-side wiring (queries,
 * polls, import/decide flows) lives in hooks/useReconciliation.ts.
 */

import type {
  BankStatementStatus,
  MatchProposalViewStatus,
} from "@workspace/api-client-react";

import type { BadgeTone } from "@/components/ui";

import { humanize } from "./format";

// The server rejects statements above 4M characters (SEC-M3); catch that
// locally so a huge file fails fast with a clear message instead of a 413.
export const MAX_CSV_CHARS = 4_000_000;

// Shown at both pickFile oversize checkpoints (the picker's size probe and the
// post-read length check) — one constant so the wording can't drift between
// them.
export const CSV_TOO_LARGE_MESSAGE =
  "That file is too large for a bank statement. Export a shorter date range and try again.";

// How many parse-report rows to render — a full statement can be hundreds of
// lines and the report is a decision aid, not a ledger.
export const MAX_REPORT_ROWS = 20;

export const STATEMENT_STATUS_TONE: Record<BankStatementStatus, BadgeTone> = {
  validated: "info",
  committed: "warning",
  reconciled: "success",
};

export const STATEMENT_STATUS_LABEL: Record<BankStatementStatus, string> = {
  validated: "Preview",
  committed: "Matching…",
  reconciled: "Ready",
};

export const PROPOSAL_STATUS_TONE: Record<MatchProposalViewStatus, BadgeTone> =
  {
    proposed: "info",
    accepted: "success",
    rejected: "neutral",
    superseded: "neutral",
  };

export const PROPOSAL_STATUS_LABEL: Record<MatchProposalViewStatus, string> = {
  proposed: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded",
};

// Friendly names for the bank export formats the parser recognises.
export const FORMAT_LABEL: Record<string, string> = {
  gtb_csv: "GTBank",
  zenith_csv: "Zenith Bank",
  access_csv: "Access Bank",
  generic_csv: "Bank CSV",
};

export function formatLabel(key: string | null | undefined): string {
  if (!key) return "Unknown format";
  return FORMAT_LABEL[key] ?? humanize(key);
}

export function percent(rate: number | string): string {
  const n = Number(rate);
  if (Number.isNaN(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export function confidenceTone(confidence: string): BadgeTone {
  const n = Number(confidence);
  if (Number.isNaN(n)) return "neutral";
  if (n >= 0.75) return "success";
  if (n >= 0.5) return "warning";
  return "neutral";
}

/** Non-blank lines in a pasted CSV, headers included (CRLF-tolerant). */
export function csvLineCount(csv: string): number {
  return csv.split(/\r?\n/).filter((l) => l.trim()).length;
}
