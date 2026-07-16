// Migration 0014 — async batch intake guardrails (Clerk idea #8).
//
// clerk_batches is tenant data: each row is ONE firm's uploaded bundle plus
// its progress counters, and sourceText holds untrusted client document
// content until processing finishes. Same firm-keyed-or-bypass posture as
// 0009's Clerk tables — a firm principal reads only its own batches, the
// processing sweep runs with app.bypass='on', and sub-tenant (client_user)
// narrowing stays at the route layer via createdBy exactly like clerk_cases.
// Idempotent `up`, reversed by `down` (rollback-test covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE clerk_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE clerk_batches FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_batches;
CREATE POLICY meridian_clerk_tenant ON clerk_batches
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON clerk_batches;
ALTER TABLE clerk_batches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE clerk_batches DISABLE ROW LEVEL SECURITY;
`;

export const migration0014 = {
  version: 14,
  name: "batch_guardrails",
  up,
  down,
};
