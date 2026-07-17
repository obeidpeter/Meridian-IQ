import { and, eq, inArray } from "drizzle-orm";
import { db, getDb, partiesTable, partyNameAliasesTable } from "@workspace/db";
import { logger } from "../../lib/logger";

// Buyer/supplier alias memory (exhaust idea #6). Supplier memory learns
// DOCUMENTS; this learns NAMES: every approval pairs the extracted party
// names with the register parties a human confirmed, and that pairing is
// remembered per firm under a normalized key. Future suggestions — console
// review chips, NL invoice drafting — consult the memory FIRST,
// deterministically. No model is involved at either end; the write is
// best-effort exhaust (an alias failure must never fail an approval), and
// the newest confirmation wins when a name is re-pointed.

// Mirrors party-match/exemplar/register-preflight: legal-form suffixes carry
// no identity.
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

// The normalized alias key: uppercase meaningful tokens, sorted and joined.
// Sorting makes "Foods Adaeze" and "Adaeze Foods" the same memory; dropping
// generic tokens makes "Adaeze Foods Ltd" match "ADAEZE FOODS". Null when the
// name carries no identity worth remembering.
export function aliasKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const tokens = [
    ...new Set(
      name
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t)),
    ),
  ].sort();
  if (tokens.length === 0) return null;
  const key = tokens.join(" ");
  return key.length >= 4 ? key : null;
}

export interface AliasEntry {
  // What the document said.
  extractedName: string | null;
  // The register party a human confirmed. Its register name is loaded here —
  // an alias identical to it teaches nothing (ordinary matching already finds
  // it) and is skipped.
  partyId: string;
}

// Record the extracted-name → confirmed-party pairings from one approval.
// Best-effort by design: log and continue on any failure. EVERYTHING —
// including the register-name reads — runs on the RAW pool (root client),
// never the ambient request transaction: a statement error inside an ambient
// transaction poisons it even when the JS error is caught, which would fail
// the approval at commit — exactly what "best-effort exhaust" must never do.
// The caller invokes this only after the approval's compare-and-set has
// already succeeded (and assertPartyInFirm validated the ids), so a raw
// write cannot record an alias for a losing concurrent decision.
export async function recordPartyAliases(
  firmId: string | null,
  entries: AliasEntry[],
): Promise<void> {
  if (!firmId) return;
  try {
    const partyIds = [...new Set(entries.map((e) => e.partyId))];
    if (partyIds.length === 0) return;
    const parties = await db
      .select({ id: partiesTable.id, legalName: partiesTable.legalName })
      .from(partiesTable)
      .where(inArray(partiesTable.id, partyIds));
    const legalName = new Map(parties.map((p) => [p.id, p.legalName]));
    for (const entry of entries) {
      const key = aliasKey(entry.extractedName);
      if (!key) continue;
      const registerName = legalName.get(entry.partyId);
      if (!registerName) continue;
      if (key === aliasKey(registerName)) continue;
      await db
        .insert(partyNameAliasesTable)
        .values({ firmId, partyId: entry.partyId, alias: key })
        .onConflictDoUpdate({
          target: [partyNameAliasesTable.firmId, partyNameAliasesTable.alias],
          set: { partyId: entry.partyId, updatedAt: new Date() },
        });
    }
  } catch (err) {
    logger.warn({ err, firmId }, "party alias memory write failed; skipping");
  }
}

// The remembered party for a document name, or null. Callers must still
// verify the returned party against their own candidate set (type, sphere,
// merge status) — the memory nominates, the caller's filters decide.
export async function lookupPartyAlias(
  firmId: string | null,
  name: string | null | undefined,
): Promise<string | null> {
  if (!firmId) return null;
  const key = aliasKey(name);
  if (!key) return null;
  try {
    const [row] = await getDb()
      .select({ partyId: partyNameAliasesTable.partyId })
      .from(partyNameAliasesTable)
      .where(
        and(
          eq(partyNameAliasesTable.firmId, firmId),
          eq(partyNameAliasesTable.alias, key),
        ),
      )
      .limit(1);
    return row?.partyId ?? null;
  } catch (err) {
    logger.warn({ err, firmId }, "party alias lookup failed; skipping");
    return null;
  }
}
