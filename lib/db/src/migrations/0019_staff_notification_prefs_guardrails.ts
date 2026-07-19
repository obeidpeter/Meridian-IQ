// Migration 0019 — staff notification-preference guardrails.
//
// staff_notification_preferences records which firm members opted in to the
// weekly digest and through which channels — tenant data (it names a firm and
// carries a member's chosen email address). Same firm-keyed-or-bypass posture
// as the other tenant tables: a firm principal reads and writes only rows in
// its own firm (the route additionally pins writes to the caller's OWN userId
// — self-service, RLS is the tenant wall, not the per-user one); the digest
// delivery sweep runs with app.bypass='on'. Idempotent `up`, reversed by
// `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE staff_notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_notification_preferences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON staff_notification_preferences;
CREATE POLICY meridian_tenant_isolation ON staff_notification_preferences
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON staff_notification_preferences;
ALTER TABLE staff_notification_preferences NO FORCE ROW LEVEL SECURITY;
ALTER TABLE staff_notification_preferences DISABLE ROW LEVEL SECURITY;
`;

export const migration0019 = {
  version: 19,
  name: "staff_notification_prefs_guardrails",
  up,
  down,
};
