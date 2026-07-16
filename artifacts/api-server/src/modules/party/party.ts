import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import {
  getDb,
  partiesTable,
  type Party,
  type PartyType,
} from "@workspace/db";
import { DomainError } from "../errors";
import { appendAudit } from "../audit/audit";
import {
  clientPartyScope,
  tenantFirmId,
  type Principal,
} from "../auth/rbac";

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

// Shared validate-normalize-or-throw used by both write paths (createParty
// and updateParty), so the two cannot drift on error codes or messages.
function normalizeTinOrThrow(raw: string): string {
  const check = validateTin(raw);
  if (!check.valid) {
    throw new DomainError("INVALID_TIN", "TIN failed validation", 400);
  }
  return check.normalized;
}

function normalizeCacOrThrow(raw: string): string {
  const check = validateCac(raw);
  if (!check.valid) {
    throw new DomainError("INVALID_CAC", "CAC number failed validation", 400);
  }
  return check.normalized;
}

// The parties table is the SHARED SPINE — no tenant key, no RLS — so every
// firm-facing read must scope to the caller's party SPHERE in app code. Three
// ways into a firm's sphere: an engagement, appearing on one of the firm's
// invoices, or having been captured by the firm (provenance column). A
// client_user (SEC-03) gets the strictly narrower version: its OWN party,
// parties on its OWN invoices, and parties it captured itself — never a
// sibling client's customer list. Null = cross-tenant staff (operator,
// auditor) see the whole spine. Shared by GET /parties and every other
// surface that suggests or lists parties to firm principals, so the two can
// never drift apart.
export function partySphereCondition(principal: Principal): SQL | null {
  const tenant = tenantFirmId(principal);
  if (tenant === null) return null;
  const scope = clientPartyScope(principal);
  return scope === null
    ? sql`(
        ${partiesTable.id} IN (
          SELECT client_party_id FROM engagements WHERE firm_id = ${tenant}
        )
        OR ${partiesTable.createdByFirmId} = ${tenant}
        OR EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.firm_id = ${tenant}
            AND (i.supplier_party_id = ${partiesTable.id}
              OR i.buyer_party_id = ${partiesTable.id})
        )
      )`
    : sql`(
        ${partiesTable.id} = ${scope}
        OR ${partiesTable.createdByUserId} = ${principal.userId}
        OR EXISTS (
          SELECT 1 FROM invoices i
          WHERE i.firm_id = ${tenant}
            AND i.supplier_party_id = ${scope}
            AND (i.supplier_party_id = ${partiesTable.id}
              OR i.buyer_party_id = ${partiesTable.id})
        )
      )`;
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
  // Provenance from the authenticated principal (never client input): lets a
  // newly captured customer appear in its creator's party lists before any
  // invoice references it. Parties remain shared spine entities (CORE-08).
  createdByFirmId?: string | null,
): Promise<Party> {
  let tin = input.tin ?? null;
  let tinValidated = false;
  if (tin) {
    tin = normalizeTinOrThrow(tin);
    tinValidated = true;
  }
  let cac = input.cacNumber ?? null;
  if (cac) {
    cac = normalizeCacOrThrow(cac);
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
      createdByFirmId: createdByFirmId ?? null,
      createdByUserId: actorId ?? null,
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

export interface UpdatePartyInput {
  legalName?: string;
  tin?: string | null;
  cacNumber?: string | null;
  street?: string | null;
  city?: string | null;
  countryCode?: string;
}

// Correct a party's registration data (fix-and-retry flow: a rejected TIN or
// missing address is fixed here, then the failed invoice is re-submitted).
// Merged duplicates are frozen — the survivor is the editable record.
export async function updateParty(
  id: string,
  patch: UpdatePartyInput,
  actorId?: string,
): Promise<Party> {
  const existing = await getParty(id);
  if (!existing) throw new DomainError("NOT_FOUND", "Party not found", 404);
  if (existing.mergedIntoId) {
    throw new DomainError(
      "PARTY_MERGED",
      "This party was merged; edit the surviving party instead",
      409,
    );
  }
  const values: Partial<typeof partiesTable.$inferInsert> = {};
  if (patch.legalName !== undefined) values.legalName = patch.legalName;
  if (patch.tin !== undefined) {
    if (patch.tin === null || patch.tin.trim() === "") {
      values.tin = null;
      values.tinValidated = false;
    } else {
      values.tin = normalizeTinOrThrow(patch.tin);
      values.tinValidated = true;
    }
  }
  if (patch.cacNumber !== undefined) {
    if (patch.cacNumber === null || patch.cacNumber.trim() === "") {
      values.cacNumber = null;
    } else {
      values.cacNumber = normalizeCacOrThrow(patch.cacNumber);
    }
  }
  if (patch.street !== undefined) values.street = patch.street;
  if (patch.city !== undefined) values.city = patch.city;
  if (patch.countryCode !== undefined) values.countryCode = patch.countryCode;
  if (Object.keys(values).length === 0) return existing;

  const [row] = await getDb()
    .update(partiesTable)
    .set(values)
    .where(eq(partiesTable.id, id))
    .returning();
  await appendAudit({
    actorId,
    action: "party.update",
    entityType: "party",
    entityId: id,
    before: {
      legalName: existing.legalName,
      tin: existing.tin,
      cacNumber: existing.cacNumber,
    },
    after: { legalName: row.legalName, tin: row.tin, cacNumber: row.cacNumber },
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

// Merge a duplicate into a survivor. History is preserved: the duplicate row is
// retained and flagged (mergedIntoId), consumers exclude merged rows from live
// views and matching (e.g. clerk party-match filters isNull(mergedIntoId) and
// console party lists filter !mergedIntoId), and the action is audited.
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
  // Compare-and-set: fold the "not yet merged" precondition into the UPDATE so a
  // concurrent merge of the same duplicate loses the race with a 409 instead of
  // a lost update / inconsistent lineage (CON-M6).
  const [merged] = await getDb()
    .update(partiesTable)
    .set({ mergedIntoId: survivorId })
    .where(
      and(eq(partiesTable.id, duplicateId), isNull(partiesTable.mergedIntoId)),
    )
    .returning({ id: partiesTable.id });
  if (!merged) {
    throw new DomainError("ALREADY_MERGED", "Duplicate already merged", 409);
  }
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
