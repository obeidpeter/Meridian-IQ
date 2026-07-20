// Migration 0022 — firm integrations guardrails (API keys + outbound webhooks).
//
// firm_api_keys, firm_webhooks and firm_webhook_deliveries are tenant data: a
// key is a firm's machine credential, a webhook names where a firm's events
// go, and each delivery row records one attempt at that firm's endpoint.
// Same firm-keyed-or-bypass posture as the other tenant tables (0013/0019/
// 0020): a firm principal reads and writes only its own firm's rows; the
// pre-context auth lookup and the fan-out/dispatch sweeps run with
// app.bypass='on' (raw pool / runInBypassContext). firm_webhook_deliveries
// carries a denormalized firm_id precisely so this policy can key on it
// directly, without a join the RLS planner cannot see. Idempotent `up`,
// reversed by `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE firm_api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_api_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_api_keys;
CREATE POLICY meridian_tenant_isolation ON firm_api_keys
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});

ALTER TABLE firm_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_webhooks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_webhooks;
CREATE POLICY meridian_tenant_isolation ON firm_webhooks
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});

ALTER TABLE firm_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_webhook_deliveries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_webhook_deliveries;
CREATE POLICY meridian_tenant_isolation ON firm_webhook_deliveries
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_webhook_deliveries;
ALTER TABLE firm_webhook_deliveries NO FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_webhook_deliveries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_webhooks;
ALTER TABLE firm_webhooks NO FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_webhooks DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meridian_tenant_isolation ON firm_api_keys;
ALTER TABLE firm_api_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE firm_api_keys DISABLE ROW LEVEL SECURITY;
`;

export const migration0022 = {
  version: 22,
  name: "integrations_guardrails",
  up,
  down,
};
