import { inArray, isNull, and } from "drizzle-orm";
import { getDb, partiesTable, type Party } from "@workspace/db";
import { DomainError } from "../errors";
import { getCase } from "./cases";
import { lookupPartyAlias } from "./alias";

// Party-matching suggestions at approval (pilot target: ≥70% of cases without
// manual re-keying). The extraction already proposes supplier/buyer names and
// TINs; this scores them against the parties register so the console can
// pre-select candidates instead of making the operator scan a dropdown.
//
// Same posture as the reconciliation matcher (SME-07): pure scoring functions,
// deterministic features recorded on every suggestion, and a SUGGESTION only —
// the operator confirms party identity like every other critical field
// (CLK-CAP-06); nothing is auto-applied.

export interface PartySuggestion {
  partyId: string;
  legalName: string;
  tin: string | null;
  type: string;
  confidence: number;
  tinScore: number;
  nameScore: number;
  // Alias memory (idea #6): true when this suggestion came from a remembered
  // extracted-name → party pairing a human previously confirmed.
  viaAlias?: boolean;
}

export interface PartySuggestions {
  supplier: PartySuggestion[];
  buyer: PartySuggestion[];
}

// A TIN hit identifies a party nearly uniquely; the name is corroboration.
const WEIGHTS = { tin: 0.6, name: 0.4 } as const;
const SUGGESTION_THRESHOLD = 0.3;
const MAX_SUGGESTIONS = 3;

function normalizeTin(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Exact match after stripping separators ("1234-5678" vs "12345678").
// Anything else is 0: TINs are identifiers, not prose — near-misses are
// different taxpayers, and a wrong pre-selected identity is worse than none.
export function tinScore(extracted: string | null, party: string | null): number {
  const a = normalizeTin(extracted);
  const b = normalizeTin(party);
  if (a.length < 6 || b.length < 6) return 0;
  return a === b ? 1 : 0;
}

// Legal-form suffixes carry no identity ("LTD" matches every other company).
const GENERIC_TOKENS = new Set([
  "LTD",
  "LIMITED",
  "PLC",
  "CO",
  "COMPANY",
  "ENTERPRISES",
  "ENTERPRISE",
  "VENTURES",
  "AND",
  "THE",
  "OF",
]);

function nameTokens(name: string): string[] {
  const all = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3);
  const meaningful = all.filter((t) => !GENERIC_TOKENS.has(t));
  // "The Company Ltd" must still be comparable to itself.
  return meaningful.length > 0 ? meaningful : all;
}

// Token overlap over the smaller side, so "Chukwuma Stores" matches
// "Chukwuma Stores Nigeria Ltd" at full score. Extracted names come from
// documents (truncation, OCR case noise); containment beats strict equality.
export function nameScore(extracted: string | null, partyName: string): number {
  if (!extracted?.trim()) return 0;
  const a = nameTokens(extracted);
  const b = nameTokens(partyName);
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const hits = new Set(a.filter((t) => bSet.has(t))).size;
  return Math.min(1, hits / Math.min(new Set(a).size, bSet.size));
}

export function scorePartyCandidates(
  extracted: { name: string | null; tin: string | null },
  candidates: Pick<Party, "id" | "legalName" | "tin" | "type">[],
): PartySuggestion[] {
  if (!extracted.name?.trim() && !normalizeTin(extracted.tin)) return [];
  const scored: PartySuggestion[] = [];
  for (const p of candidates) {
    const tScore = tinScore(extracted.tin, p.tin);
    const nScore = nameScore(extracted.name, p.legalName);
    const confidence =
      Math.round((WEIGHTS.tin * tScore + WEIGHTS.name * nScore) * 10000) /
      10000;
    if (confidence < SUGGESTION_THRESHOLD) continue;
    scored.push({
      partyId: p.id,
      legalName: p.legalName,
      tin: p.tin,
      type: p.type,
      confidence,
      tinScore: tScore,
      nameScore: Math.round(nScore * 10000) / 10000,
    });
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, MAX_SUGGESTIONS);
}

export async function suggestPartiesForCase(
  caseId: string,
): Promise<PartySuggestions> {
  const kase = await getCase(caseId);
  if (kase.kind !== "extraction") {
    throw new DomainError(
      "CASE_BAD_KIND",
      "Party suggestions apply to extraction cases only",
      409,
    );
  }
  const fields = new Map(
    (kase.extraction?.fields ?? []).map((f) => [f.field, f.value]),
  );
  const supplierIdentity = {
    name: fields.get("supplierName") ?? null,
    tin: fields.get("supplierTin") ?? null,
  };
  const buyerIdentity = {
    name: fields.get("buyerName") ?? null,
    tin: fields.get("buyerTin") ?? null,
  };

  // Merged parties are tombstones pointing at their survivor; never suggest
  // them. Suppliers are client businesses; buyers may be registered buyers or
  // other client businesses (B2B between two clients of the firm).
  const candidates = await getDb()
    .select({
      id: partiesTable.id,
      legalName: partiesTable.legalName,
      tin: partiesTable.tin,
      type: partiesTable.type,
    })
    .from(partiesTable)
    .where(
      and(
        isNull(partiesTable.mergedIntoId),
        inArray(partiesTable.type, ["client_business", "buyer"]),
      ),
    );

  const supplier = scorePartyCandidates(
    supplierIdentity,
    candidates.filter((c) => c.type === "client_business"),
  );
  const buyer = scorePartyCandidates(buyerIdentity, candidates);

  // Alias memory (idea #6): a remembered pairing outranks scoring — a human
  // already confirmed this exact document name means that party. The memory
  // only NOMINATES; the party must still be in the candidate set above
  // (right type, not merged) before it may lead.
  return {
    supplier: await applyAlias(
      kase.firmId,
      supplierIdentity.name,
      supplier,
      candidates.filter((c) => c.type === "client_business"),
    ),
    buyer: await applyAlias(kase.firmId, buyerIdentity.name, buyer, candidates),
  };
}

export async function applyAlias(
  firmId: string | null,
  extractedName: string | null,
  scored: PartySuggestion[],
  candidates: Pick<Party, "id" | "legalName" | "tin" | "type">[],
): Promise<PartySuggestion[]> {
  const partyId = await lookupPartyAlias(firmId, extractedName);
  if (!partyId) return scored;
  const candidate = candidates.find((c) => c.id === partyId);
  if (!candidate) return scored;
  const aliasSuggestion: PartySuggestion = {
    partyId: candidate.id,
    legalName: candidate.legalName,
    tin: candidate.tin,
    type: candidate.type,
    confidence: 1,
    tinScore: 0,
    nameScore: 1,
    viaAlias: true,
  };
  return [
    aliasSuggestion,
    ...scored.filter((s) => s.partyId !== partyId),
  ].slice(0, MAX_SUGGESTIONS);
}
