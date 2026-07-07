import { eq } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  invoicesTable,
  type Party,
  type PartyType,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";

// Party integrity (CORE-08): TIN/CAC validation and merge/split that preserve
// history (rows are never deleted; lineage is recorded via mergedIntoId + audit).

// Nigerian TIN: commonly a 10-digit number, optionally with a 4-digit suffix
// (e.g. "12345678-0001"). We normalize and structurally validate; a real
// registry lookup would replace the simulated check.
export function validateTin(raw: string): { valid: boolean; normalized: string } {
  const normalized = raw.trim().replace(/\s+/g, "");
  const valid = /^\d{8,10}(-\d{4})?$/.test(normalized);
  return { valid, normalized };
}

// CAC number: "RC" (companies) or "BN" (business names) + digits.
export function validateCac(raw: string): { valid: boolean; normalized: string } {
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, "");
  const valid = /^(RC|BN)\d{2,8}$/.test(normalized);
  return { valid, normalized };
}

export interface CreatePartyInput {
  type: PartyType;
  legalName: string;
  tin?: string | null;
  cacNumber?: string | null;
  street?: string | null;
  city?: string | null;
  countryCode?: string;
}

export async function createParty(
  input: CreatePartyInput,
  actorId?: string,
): Promise<Party> {
  let tin = input.tin ?? null;
  let tinValidated = false;
  if (tin) {
    const check = validateTin(tin);
    if (!check.valid) {
      throw new DomainError("INVALID_TIN", "TIN failed validation", 400);
    }
    tin = check.normalized;
    tinValidated = true;
  }
  let cac = input.cacNumber ?? null;
  if (cac) {
    const check = validateCac(cac);
    if (!check.valid) {
      throw new DomainError("INVALID_CAC", "CAC number failed validation", 400);
    }
    cac = check.normalized;
  }
  const [row] = await getDb()
    .insert(partiesTable)
    .values({
      type: input.type,
      legalName: input.legalName,
      tin,
      tinValidated,
      cacNumber: cac,
      street: input.street ?? null,
      city: input.city ?? null,
      countryCode: input.countryCode ?? "NG",
    })
    .returning();
  await appendAudit({
    actorId,
    action: "party.create",
    entityType: "party",
    entityId: row.id,
    after: { legalName: row.legalName, tin: row.tin },
  });
  return row;
}

export async function getParty(id: string): Promise<Party | null> {
  const [row] = await getDb()
    .select()
    .from(partiesTable)
    .where(eq(partiesTable.id, id))
    .limit(1);
  return row ?? null;
}

// Follow the merge chain to the surviving party.
export async function resolveParty(id: string): Promise<Party | null> {
  let current = await getParty(id);
  const seen = new Set<string>();
  while (current?.mergedIntoId && !seen.has(current.id)) {
    seen.add(current.id);
    current = await getParty(current.mergedIntoId);
  }
  return current;
}

// Merge a duplicate into a survivor. History is preserved: the duplicate row is
// retained and flagged (mergedIntoId), future reads resolve through it, and the
// action is audited.
export async function mergeParties(
  survivorId: string,
  duplicateId: string,
  actorId?: string,
): Promise<void> {
  if (survivorId === duplicateId) {
    throw new DomainError("INVALID_MERGE", "Cannot merge a party into itself", 400);
  }
  const survivor = await getParty(survivorId);
  const duplicate = await getParty(duplicateId);
  if (!survivor || !duplicate) {
    throw new DomainError("NOT_FOUND", "Party not found", 404);
  }
  if (duplicate.mergedIntoId) {
    throw new DomainError("ALREADY_MERGED", "Duplicate already merged", 409);
  }
  await getDb()
    .update(partiesTable)
    .set({ mergedIntoId: survivorId })
    .where(eq(partiesTable.id, duplicateId));
  await appendAudit({
    actorId,
    action: "party.merge",
    entityType: "party",
    entityId: duplicateId,
    before: { mergedIntoId: null },
    after: { mergedIntoId: survivorId },
  });
}

// Split: reverse a merge (e.g. a false-positive duplicate). History preserved
// via audit; the party becomes independent again.
export async function splitParty(
  partyId: string,
  actorId?: string,
): Promise<void> {
  const party = await getParty(partyId);
  if (!party) throw new DomainError("NOT_FOUND", "Party not found", 404);
  if (!party.mergedIntoId) {
    throw new DomainError("NOT_MERGED", "Party is not merged", 409);
  }
  const previous = party.mergedIntoId;
  await getDb()
    .update(partiesTable)
    .set({ mergedIntoId: null })
    .where(eq(partiesTable.id, partyId));
  await appendAudit({
    actorId,
    action: "party.split",
    entityType: "party",
    entityId: partyId,
    before: { mergedIntoId: previous },
    after: { mergedIntoId: null },
  });
}

// Count invoices referencing a party (used to surface merge impact).
export async function invoiceCountForParty(partyId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(eq(invoicesTable.supplierPartyId, partyId));
  return rows.length;
}
