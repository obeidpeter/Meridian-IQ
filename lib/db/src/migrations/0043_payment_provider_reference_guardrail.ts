// Migration 0043 - a provider reference identifies exactly one payment
// intent. Provider confirmation webhooks resolve by this key without a tenant
// hint, so duplicate references must fail at the database boundary.

const up = `
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_provider_ref_uq
  ON payment_intents (provider_ref)
  WHERE provider_ref IS NOT NULL;
`;

const down = `
DROP INDEX IF EXISTS payment_intents_provider_ref_uq;
`;

export const migration0043 = {
  version: 43,
  name: "payment_provider_reference_guardrail",
  up,
  down,
};
