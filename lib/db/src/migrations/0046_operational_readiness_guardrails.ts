// Platform-wide scheduler/backup freshness is visible only to trusted bypass
// principals and internal jobs. The table carries no firm id, so a normal
// tenant transaction must see no rows and must never be able to forge health.

const up = `
ALTER TABLE operational_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_heartbeats FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_operational_bypass ON operational_heartbeats;
CREATE POLICY meridian_operational_bypass ON operational_heartbeats
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const down = `
DROP POLICY IF EXISTS meridian_operational_bypass ON operational_heartbeats;
ALTER TABLE operational_heartbeats NO FORCE ROW LEVEL SECURITY;
ALTER TABLE operational_heartbeats DISABLE ROW LEVEL SECURITY;
`;

export const migration0046 = {
  version: 46,
  name: "operational_readiness_guardrails",
  up,
  down,
};
