// Reconciliation v1 matching engine (SME-07). Pure functions: statement lines
// in, scored invoice-match proposals out — no I/O, so the 85% acceptance
// bar is provable on a fixture book and every confidence is deterministically
// recomputable from its recorded features.
//
// Two lanes since the payables round (contract 0.44.0), split by the
// candidate's ORIENTATION discriminator:
//  - credits settle RECEIVABLES (the client is the supplier; the narration
//    counterparty is the buyer) — the original lane, unchanged;
//  - debits pay BILLS (the client is the buyer of a captured supplier
//    invoice; the narration counterparty is the SUPPLIER).
// A credit never matches a bill and a debit never matches a receivable.

export type CandidateOrientation = "receivable" | "bill";

export interface MatchCandidate {
  invoiceId: string;
  invoiceNumber: string;
  // The name expected in the bank narration: the BUYER for a receivable
  // (who paid us), the SUPPLIER for a bill (who we paid).
  counterpartyName: string;
  orientation: CandidateOrientation;
  grandTotal: number;
  issueDate: string; // ISO yyyy-mm-dd
  dueDate: string | null;
}

export interface MatchableLine {
  lineId: string;
  valueDate: string | null; // ISO yyyy-mm-dd
  amount: number;
  direction: "credit" | "debit" | null;
  narration: string | null;
  counterpartyRef: string | null;
}

export interface MatchFeatures {
  amountScore: number;
  referenceScore: number;
  dateScore: number;
  nameScore: number;
}

export interface ScoredMatch {
  lineId: string;
  invoiceId: string;
  orientation: CandidateOrientation;
  confidence: number;
  features: MatchFeatures;
}

// Weights sum to 1. Amount agreement is necessary evidence (a proposal is never
// made on narration alone); an invoice-number hit in the narration is the
// strongest single signal.
const WEIGHTS = {
  amount: 0.45,
  reference: 0.3,
  date: 0.15,
  name: 0.1,
} as const;

// Exported as the noise floor of the matcher's confidence scale: the
// narration-match lane defines the human "middle band" as
// [PROPOSAL_THRESHOLD, DEFAULT_BULK_ACCEPT_THRESHOLD) — each bound owned by
// the module that enforces it.
export const PROPOSAL_THRESHOLD = 0.35;
const MAX_PROPOSALS_PER_LINE = 3;

function normalizeToken(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Amount agreement with tolerance bands: Nigerian transfers commonly arrive
// net of NIP/transfer fees, so near-misses still score, lower.
export function amountScore(lineAmount: number, invoiceTotal: number): number {
  if (invoiceTotal <= 0 || lineAmount <= 0) return 0;
  const diff = Math.abs(lineAmount - invoiceTotal) / invoiceTotal;
  if (diff <= 0.005) return 1;
  if (diff <= 0.02) return 0.7;
  if (diff <= 0.05) return 0.4;
  return 0;
}

// Invoice-number hit in narration or counterparty reference.
export function referenceScore(
  invoiceNumber: string,
  narration: string | null,
  counterpartyRef: string | null,
): number {
  const needle = normalizeToken(invoiceNumber);
  if (needle.length < 4) return 0;
  const hay = normalizeToken(`${narration ?? ""} ${counterpartyRef ?? ""}`);
  return hay.includes(needle) ? 1 : 0;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_WINDOW_DAYS = 60;

// Payment usually lands on or after the issue date; score decays over a
// 60-day window and a payment "before" the invoice (beyond 3 days of clock
// skew) scores zero.
export function dateScore(
  valueDate: string | null,
  issueDate: string,
): number {
  if (!valueDate) return 0;
  const paid = Date.parse(valueDate);
  const issued = Date.parse(issueDate);
  if (Number.isNaN(paid) || Number.isNaN(issued)) return 0;
  const days = (paid - issued) / DAY_MS;
  if (days < -3) return 0;
  if (days <= 0) return 1;
  if (days > DATE_WINDOW_DAYS) return 0;
  return 1 - days / DATE_WINDOW_DAYS;
}

// Counterparty-name tokens present in the narration (banks truncate and
// uppercase, so this is token containment, not equality). The counterparty is
// the buyer for a receivable, the supplier for a bill.
export function nameScore(
  counterpartyName: string,
  narration: string | null,
): number {
  if (!narration) return 0;
  const hay = normalizeToken(narration);
  const tokens = counterpartyName
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 4);
  if (tokens.length === 0) return 0;
  const hits = tokens.filter((t) => hay.includes(t)).length;
  return hits / tokens.length;
}

export function scorePair(
  line: MatchableLine,
  candidate: MatchCandidate,
): { confidence: number; features: MatchFeatures } {
  const features: MatchFeatures = {
    amountScore: amountScore(line.amount, candidate.grandTotal),
    referenceScore: referenceScore(
      candidate.invoiceNumber,
      line.narration,
      line.counterpartyRef,
    ),
    dateScore: dateScore(line.valueDate, candidate.issueDate),
    nameScore: nameScore(candidate.counterpartyName, line.narration),
  };
  const confidence =
    WEIGHTS.amount * features.amountScore +
    WEIGHTS.reference * features.referenceScore +
    WEIGHTS.date * features.dateScore +
    WEIGHTS.name * features.nameScore;
  return { confidence: Math.round(confidence * 10000) / 10000, features };
}

// Propose matches: candidates scored, filtered by the threshold, amount
// agreement required, best three per line. Direction picks the lane — only
// credits can settle a receivable, only debits can pay a bill — so a line
// only ever scores against candidates of its own orientation.
export function proposeMatches(
  lines: MatchableLine[],
  candidates: MatchCandidate[],
): ScoredMatch[] {
  const proposals: ScoredMatch[] = [];
  for (const line of lines) {
    const lane: CandidateOrientation | null =
      line.direction === "credit"
        ? "receivable"
        : line.direction === "debit"
          ? "bill"
          : null;
    if (lane === null || line.amount <= 0) continue;
    const scored: ScoredMatch[] = [];
    for (const candidate of candidates) {
      if (candidate.orientation !== lane) continue;
      const { confidence, features } = scorePair(line, candidate);
      if (features.amountScore === 0) continue;
      if (confidence < PROPOSAL_THRESHOLD) continue;
      scored.push({
        lineId: line.lineId,
        invoiceId: candidate.invoiceId,
        orientation: candidate.orientation,
        confidence,
        features,
      });
    }
    scored.sort((a, b) => b.confidence - a.confidence);
    proposals.push(...scored.slice(0, MAX_PROPOSALS_PER_LINE));
  }
  return proposals;
}
