// Migration 0042 - concurrency and replay guardrails introduced by the
// comprehensive audit remediation. Schema columns are published by Drizzle;
// these idempotent indexes are reasserted at boot because they enforce money,
// intake and model-capture integrity.

const up = `
CREATE UNIQUE INDEX IF NOT EXISTS settlement_events_external_reference_uq
  ON settlement_events (external_reference)
  WHERE external_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_inbound_dedupe_idx
  ON outbox_events (type, aggregate_id)
  WHERE type IN ('inbound.email', 'inbound.whatsapp');

CREATE UNIQUE INDEX IF NOT EXISTS clerk_cases_live_dedupe_uq
  ON clerk_cases (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND status NOT IN ('failed', 'rejected');

CREATE UNIQUE INDEX IF NOT EXISTS collection_accounts_one_active_per_client
  ON collection_accounts (firm_id, client_party_id)
  WHERE active = true;
`;

const down = `
DROP INDEX IF EXISTS clerk_cases_live_dedupe_uq;
DROP INDEX IF EXISTS collection_accounts_one_active_per_client;
DROP INDEX IF EXISTS outbox_events_inbound_dedupe_idx;
DROP INDEX IF EXISTS settlement_events_external_reference_uq;
`;

export const migration0042 = {
  version: 42,
  name: "audit_remediation_guardrails",
  up,
  down,
};
