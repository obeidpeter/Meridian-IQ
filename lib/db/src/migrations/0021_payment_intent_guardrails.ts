// Migration 0021 — payment-intent guardrails.
//
// payment_intents is tenant data: each row is one firm's attempt to pay its
// own platform bill (amount, provider reference, checkout URL). Same
// firm-keyed-or-bypass posture as the other tenant tables (0013/0019/0020): a
// firm principal reads and writes only its own firm's intents; the
// confirmation webhook (a machine caller with no tenant) settles rows from a
// bypass transaction, exactly like the pipeline worker. Idempotent `up`,
// reversed by `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE payment_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_intents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON payment_intents;
CREATE POLICY meridian_tenant_isolation ON payment_intents
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON payment_intents;
ALTER TABLE payment_intents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE payment_intents DISABLE ROW LEVEL SECURITY;
`;

export const migration0021 = {
  version: 21,
  name: "payment_intent_guardrails",
  up,
  down,
};
