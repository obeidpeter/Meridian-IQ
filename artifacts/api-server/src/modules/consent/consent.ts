import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  consentRecordsTable,
  type ConsentRecord,
  type ConsentAction,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";

// Three consent layers (Plan 7.2, C6, CORE-03).
export const CONSENT_LAYERS = {
  COMPLIANCE: 1,
  ANONYMIZED_AGGREGATE: 2,
  CREDIT_READINESS: 3,
} as const;

// Every processing purpose declares the consent layer it requires. The
// permission query answers, for a given record right now, whether a purpose is
// permitted. Layer three powers the dark R3 credit-readiness surfaces and is
// enforced before either assessment or aggregate disclosure.
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
  commandId?: string | null;
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
      commandId: input.commandId ?? null,
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

export interface FirstLandingDecision {
  layer: 1 | 2;
  action: ConsentAction;
}

const FIRST_LANDING_SCOPE: Record<FirstLandingDecision["layer"], string> = {
  1: "compliance_submission",
  2: "anonymized_benchmark",
};

/**
 * Record the first-login decision pair as one database command. The ambient
 * request transaction makes the two ledger rows and their audits all-or-none;
 * the unique command key makes a response-loss retry return the same rows.
 */
export async function captureFirstLandingConsent(input: {
  partyId: string;
  commandId: string;
  decisions: FirstLandingDecision[];
  actorId?: string | null;
}): Promise<ConsentRecord[]> {
  const byLayer = new Map(
    input.decisions.map((item) => [item.layer, item.action]),
  );
  if (
    input.decisions.length !== 2 ||
    byLayer.size !== 2 ||
    !byLayer.has(1) ||
    !byLayer.has(2)
  ) {
    throw new DomainError(
      "CONSENT_CAPTURE_INCOMPLETE",
      "First-login consent must include one decision for layer 1 and one for layer 2",
      400,
    );
  }

  const values = ([1, 2] as const).map((layer) => {
    const action = byLayer.get(layer)!;
    return {
      partyId: input.partyId,
      layer,
      action,
      scope: FIRST_LANDING_SCOPE[layer],
      basis: action === "grant" ? "consent" : "declined",
      channel: "first_landing",
      commandId: input.commandId,
    };
  });
  const inserted = await getDb()
    .insert(consentRecordsTable)
    .values(values)
    .onConflictDoNothing({
      target: [
        consentRecordsTable.partyId,
        consentRecordsTable.commandId,
        consentRecordsTable.layer,
      ],
    })
    .returning();

  const rows = await getDb()
    .select()
    .from(consentRecordsTable)
    .where(
      and(
        eq(consentRecordsTable.partyId, input.partyId),
        eq(consentRecordsTable.commandId, input.commandId),
      ),
    )
    .orderBy(asc(consentRecordsTable.layer));
  const matches =
    rows.length === 2 &&
    rows.every((row) => {
      const expected = values.find((item) => item.layer === row.layer);
      return (
        expected?.action === row.action &&
        expected.scope === row.scope &&
        expected.basis === row.basis &&
        row.channel === "first_landing"
      );
    });
  if (!matches) {
    throw new DomainError(
      "CONSENT_COMMAND_CONFLICT",
      "This consent command was already used with different decisions",
      409,
    );
  }

  for (const row of inserted) {
    await appendAudit({
      actorId: input.actorId ?? null,
      action: `consent.${row.action}`,
      entityType: "consent_record",
      entityId: row.id,
      after: {
        partyId: input.partyId,
        layer: row.layer,
        scope: row.scope,
        commandId: input.commandId,
      },
    });
  }
  return rows;
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

// Has the business ever DECIDED on this layer — granted or declined? The
// first-landing capture (D15) keys off this, not off permission: a recorded
// decline is a decision too, and must not re-prompt on every sign-in.
export async function hasConsentDecision(
  partyId: string,
  layer = 1,
): Promise<boolean> {
  const [any] = await getDb()
    .select({ id: consentRecordsTable.id })
    .from(consentRecordsTable)
    .where(
      and(
        eq(consentRecordsTable.partyId, partyId),
        eq(consentRecordsTable.layer, layer),
      ),
    )
    .limit(1);
  return !!any;
}

export async function hasConsentDecisions(
  partyId: string,
  layers: number[],
): Promise<boolean> {
  const rows = await getDb()
    .select({ layer: consentRecordsTable.layer })
    .from(consentRecordsTable)
    .where(
      and(
        eq(consentRecordsTable.partyId, partyId),
        inArray(consentRecordsTable.layer, layers),
      ),
    );
  const decided = new Set(rows.map((row) => row.layer));
  return layers.every((layer) => decided.has(layer));
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
