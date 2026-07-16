// Migration 0015 — per-client monthly statement guardrails (Clerk idea #5).
//
// clerk_client_statements is tenant data: each row summarises ONE client's
// compliance month for ONE firm. Same firm-keyed-or-bypass posture as the
// digest table (0011) — a firm principal reads only its own clients'
// statements; the generating sweep runs with app.bypass='on'. Sibling-client
// isolation inside a firm (SEC-03) stays an APP responsibility: client routes
// must narrow to the caller's party, exactly as for invoices. Idempotent
// `up`, reversed by `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_client_statements ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_client_statements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_client_statements;
CREATE POLICY meridian_clerk_tenant ON clerk_client_statements
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_client_statements;
ALTER TABLE clerk_client_statements NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_client_statements DISABLE ROW LEVEL SECURITY;
`;

export const migration0015 = {
  version: 15,
  name: "client_statement_guardrails",
  up,
  down,
};
