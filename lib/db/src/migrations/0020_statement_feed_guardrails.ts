// Migration 0020 — bank-feed connection guardrails.
//
// statement_connections and statement_sync_runs are tenant data: a connection
// names a firm's client party and carries connector config; each run records
// what a pull did for that firm. Same firm-keyed-or-bypass posture as the
// other tenant tables (0013/0019): a firm principal reads and writes only its
// own firm's rows; the pipeline worker (which executes the queued sync) runs
// with app.bypass='on'. statement_sync_runs carries a denormalized firm_id
// precisely so this policy can key on it directly, without a join the RLS
// planner cannot see. Idempotent `up`, reversed by `down` (rollback-test
// covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE statement_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON statement_connections;
CREATE POLICY meridian_tenant_isolation ON statement_connections
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});

ALTER TABLE statement_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE statement_sync_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON statement_sync_runs;
CREATE POLICY meridian_tenant_isolation ON statement_sync_runs
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_tenant_isolation ON statement_sync_runs;
ALTER TABLE statement_sync_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE statement_sync_runs DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meridian_tenant_isolation ON statement_connections;
ALTER TABLE statement_connections NO FORCE ROW LEVEL SECURITY;
ALTER TABLE statement_connections DISABLE ROW LEVEL SECURITY;
`;

export const migration0020 = {
  version: 20,
  name: "statement_feed_guardrails",
  up,
  down,
};
