import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  consentRecordsTable,
  type ConsentRecord,
  type ConsentAction,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";

// Three consent layers (Plan 7.2, C6, CORE-03).
export const CONSENT_LAYERS = {
  COMPLIANCE: 1,
  ANONYMIZED_AGGREGATE: 2,
  CREDIT_READINESS: 3,
} as const;

// Every processing purpose declares the consent layer it requires. The
// permission query answers, for a given record right now, whether a purpose is
// permitted. Layer three (credit) purposes are dormant until R3 but the gate is
// enforced here from day one.
export const PURPOSE_LAYER: Record<string, number> = {
  compliance_submission: CONSENT_LAYERS.COMPLIANCE,
  vault_storage: CONSENT_LAYERS.COMPLIANCE,
  deadline_alerts: CONSENT_LAYERS.COMPLIANCE,
  // Bank-statement reconciliation is layer-1 compliance scope (Plan 7.2).
  reconciliation: CONSENT_LAYERS.COMPLIANCE,
  anonymized_benchmark: CONSENT_LAYERS.ANONYMIZED_AGGREGATE,
  aggregate_analytics: CONSENT_LAYERS.ANONYMIZED_AGGREGATE,
  credit_scoring: CONSENT_LAYERS.CREDIT_READINESS,
  bank_data_room: CONSENT_LAYERS.CREDIT_READINESS,
  financing_origination: CONSENT_LAYERS.CREDIT_READINESS,
};

export interface RecordConsentInput {
  partyId: string;
  layer: number;
  action: ConsentAction;
  scope: string;
  basis: string;
  channel: string;
  actorId?: string | null;
}

export async function recordConsent(
  input: RecordConsentInput,
): Promise<ConsentRecord> {
  const [row] = await getDb()
    .insert(consentRecordsTable)
    .values({
      partyId: input.partyId,
      layer: input.layer,
      action: input.action,
      scope: input.scope,
      basis: input.basis,
      channel: input.channel,
    })
    .returning();
  await appendAudit({
    actorId: input.actorId ?? null,
    action: `consent.${input.action}`,
    entityType: "consent_record",
    entityId: row.id,
    after: { partyId: input.partyId, layer: input.layer, scope: input.scope },
  });
  return row;
}

// Latest action for (party, layer) determines current standing. Revocation
// takes effect immediately (well under the one-minute requirement) because the
// query always reads the most recent event.
export async function hasLayerConsent(
  partyId: string,
  layer: number,
): Promise<boolean> {
  const [latest] = await getDb()
    .select({ action: consentRecordsTable.action })
    .from(consentRecordsTable)
    .where(
      and(
        eq(consentRecordsTable.partyId, partyId),
        eq(consentRecordsTable.layer, layer),
      ),
    )
    .orderBy(desc(consentRecordsTable.createdAt))
    .limit(1);
  return latest?.action === "grant";
}

// The single permission query used by every purpose-gated code path (CORE-03).
export async function isPurposePermitted(
  partyId: string,
  purpose: string,
): Promise<boolean> {
  const layer = PURPOSE_LAYER[purpose];
  if (layer === undefined) return false;
  return hasLayerConsent(partyId, layer);
}

export async function consentHistory(
  partyId: string,
): Promise<ConsentRecord[]> {
  return getDb()
    .select()
    .from(consentRecordsTable)
    .where(eq(consentRecordsTable.partyId, partyId))
    .orderBy(desc(consentRecordsTable.createdAt));
}
