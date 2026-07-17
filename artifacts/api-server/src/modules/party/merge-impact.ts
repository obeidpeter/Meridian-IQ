import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

// Merge impact preview (round-12 idea #2). The round-6 duplicate suggestions
// ask an operator to merge two parties; this shows deterministically what
// each side CARRIES before the irreversible-feeling click — invoices in both
// roles, engagements, client-user memberships, recurring templates, learned
// aliases, bank statements, escalations, consent grants (the CORE-03 spine)
// and operator cases. Counts only, one SQL pass per side, zero model calls,
// nothing stored. Same gate as the merge itself (party.merge): whoever may
// merge may preview. mergeParties only flags mergedIntoId — nothing is
// re-pointed — so a duplicate that carries the live consent grant or an open
// desk case is exactly what this preview must surface before the operator
// picks the other side as survivor.

export interface PartyMergeSide {
  partyId: string;
  legalName: string | null;
  tin: string | null;
  merged: boolean;
  invoicesAsSupplier: number;
  invoicesAsBuyer: number;
  engagements: number;
  memberships: number;
  recurringTemplates: number;
  aliases: number;
  bankStatements: number;
  escalations: number;
  consents: number;
  operatorCases: number;
}

export interface MergeImpact {
  survivor: PartyMergeSide | null;
  duplicate: PartyMergeSide | null;
}

async function sideImpact(partyId: string): Promise<PartyMergeSide | null> {
  const rows = (
    await getDb().execute<{
      legal_name: string | null;
      tin: string | null;
      merged: boolean;
      inv_supplier: number;
      inv_buyer: number;
      engagements: number;
      memberships: number;
      templates: number;
      aliases: number;
      statements: number;
      escalations: number;
      consents: number;
      operator_cases: number;
    }>(sql`
      SELECT
        p.legal_name,
        p.tin,
        (p.merged_into_id IS NOT NULL) AS merged,
        (SELECT COUNT(*) FROM invoices i WHERE i.supplier_party_id = ${partyId})::int AS inv_supplier,
        (SELECT COUNT(*) FROM invoices i WHERE i.buyer_party_id = ${partyId})::int AS inv_buyer,
        (SELECT COUNT(*) FROM engagements e WHERE e.client_party_id = ${partyId})::int AS engagements,
        (SELECT COUNT(*) FROM memberships m WHERE m.client_party_id = ${partyId})::int AS memberships,
        (SELECT COUNT(*) FROM recurring_invoice_templates t
          WHERE t.supplier_party_id = ${partyId} OR t.buyer_party_id = ${partyId})::int AS templates,
        (SELECT COUNT(*) FROM party_name_aliases a WHERE a.party_id = ${partyId})::int AS aliases,
        (SELECT COUNT(*) FROM bank_statements b WHERE b.client_party_id = ${partyId})::int AS statements,
        (SELECT COUNT(*) FROM escalations x WHERE x.client_party_id = ${partyId})::int AS escalations,
        (SELECT COUNT(*) FROM consent_records c WHERE c.party_id = ${partyId})::int AS consents,
        (SELECT COUNT(*) FROM operator_cases oc WHERE oc.client_party_id = ${partyId})::int AS operator_cases
      FROM parties p
      WHERE p.id = ${partyId}
    `)
  ).rows;
  const r = rows[0];
  if (!r) return null;
  return {
    partyId,
    legalName: r.legal_name,
    tin: r.tin,
    merged: r.merged,
    invoicesAsSupplier: Number(r.inv_supplier),
    invoicesAsBuyer: Number(r.inv_buyer),
    engagements: Number(r.engagements),
    memberships: Number(r.memberships),
    recurringTemplates: Number(r.templates),
    aliases: Number(r.aliases),
    bankStatements: Number(r.statements),
    escalations: Number(r.escalations),
    consents: Number(r.consents),
    operatorCases: Number(r.operator_cases),
  };
}

export async function computeMergeImpact(
  survivorId: string,
  duplicateId: string,
): Promise<MergeImpact> {
  return {
    survivor: await sideImpact(survivorId),
    duplicate: await sideImpact(duplicateId),
  };
}
