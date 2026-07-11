// Migration 0003 — push-device tenant isolation.
//
// Extends the tenant row-level-security posture of migrations 0001/0002 to the
// mobile push-token registry: the device rows snapshot the registering
// principal's firm, so a firm-scoped session may only see/write rows of its own
// firm. `IS NOT DISTINCT FROM` (rather than the plain FIRM_MATCH equality used
// on the always-firm-keyed tables) also covers rows whose firm_id is NULL:
// those are only reachable by bypass sessions (operators/background fan-out),
// never by another tenant. Idempotent so it can be re-asserted on boot; `down`
// fully reverses it (covered by rollback test).

const PUSH_FIRM_MATCH =
  "firm_id IS NOT DISTINCT FROM nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_devices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON push_devices;
CREATE POLICY meridian_tenant_isolation ON push_devices
  USING (current_setting('app.bypass', true) = 'on' OR ${PUSH_FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${PUSH_FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON push_devices;
ALTER TABLE push_devices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE push_devices DISABLE ROW LEVEL SECURITY;
`;

export const migration0003 = {
  version: 3,
  name: "push_guardrails",
  up,
  down,
};
