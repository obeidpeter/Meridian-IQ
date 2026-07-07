// Reconciliation v1 matching engine (SME-07). Pure functions: statement credit
// lines in, scored invoice-match proposals out — no I/O, so the 85% acceptance
// bar is provable on a fixture book and every confidence is deterministically
// recomputable from its recorded features.

export interface MatchCandidate {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
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

const PROPOSAL_THRESHOLD = 0.35;
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

// Buyer-name tokens present in the narration (banks truncate and uppercase, so
// this is token containment, not equality).
export function nameScore(buyerName: string, narration: string | null): number {
  if (!narration) return 0;
  const hay = normalizeToken(narration);
  const tokens = buyerName
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
    nameScore: nameScore(candidate.buyerName, line.narration),
  };
  const confidence =
    WEIGHTS.amount * features.amountScore +
    WEIGHTS.reference * features.referenceScore +
    WEIGHTS.date * features.dateScore +
    WEIGHTS.name * features.nameScore;
  return { confidence: Math.round(confidence * 10000) / 10000, features };
}

// Propose matches for every credit line: candidates scored, filtered by the
// threshold, amount agreement required, best three per line.
export function proposeMatches(
  lines: MatchableLine[],
  candidates: MatchCandidate[],
): ScoredMatch[] {
  const proposals: ScoredMatch[] = [];
  for (const line of lines) {
    // Only credits can settle a receivable.
    if (line.direction !== "credit" || line.amount <= 0) continue;
    const scored: ScoredMatch[] = [];
    for (const candidate of candidates) {
      const { confidence, features } = scorePair(line, candidate);
      if (features.amountScore === 0) continue;
      if (confidence < PROPOSAL_THRESHOLD) continue;
      scored.push({
        lineId: line.lineId,
        invoiceId: candidate.invoiceId,
        confidence,
        features,
      });
    }
    scored.sort((a, b) => b.confidence - a.confidence);
    proposals.push(...scored.slice(0, MAX_PROPOSALS_PER_LINE));
  }
  return proposals;
}
