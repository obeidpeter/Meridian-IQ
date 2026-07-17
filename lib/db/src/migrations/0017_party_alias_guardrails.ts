// Migration 0017 — party-name alias guardrails (Clerk idea #6).
//
// party_name_aliases pairs a firm's document vocabulary ("Adaeze Foods") with
// its own register parties — tenant data in both directions. Same
// firm-keyed-or-bypass posture as the digest/statement tables: a firm
// principal reads only its own aliases; sweeps and operators run with
// app.bypass='on'. Idempotent `up`, reversed by `down` (rollback-test
// covered).

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
ALTER TABLE party_name_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_name_aliases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_clerk_tenant ON party_name_aliases;
CREATE POLICY meridian_clerk_tenant ON party_name_aliases
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const down = `
DROP POLICY IF EXISTS meridian_clerk_tenant ON party_name_aliases;
ALTER TABLE party_name_aliases NO FORCE ROW LEVEL SECURITY;
ALTER TABLE party_name_aliases DISABLE ROW LEVEL SECURITY;
`;

export const migration0017 = {
  version: 17,
  name: "party_alias_guardrails",
  up,
  down,
};
