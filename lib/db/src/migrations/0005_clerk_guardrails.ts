// Migration 0005 — Clerk v0 guardrails (Task #40).
//
// clerk_inference_calls is the append-only audit ledger of every model call:
// UPDATE/DELETE are blocked by the shared meridian_block_mutations trigger
// (from migration 0001), matching the other immutable ledgers.
//
// clerk_cases and clerk_inference_calls hold cross-tenant PII (uploaded invoice
// documents, TINs) and unreviewed model output. Migration 0001's default
// privileges make every pushed table reachable by meridian_app, so without a
// policy any firm-scoped session could read them. Both tables are therefore
// RLS'd bypass-only: reachable exclusively by principals running with
// app.bypass='on' (operator/auditor/system), never by firm-scoped sessions.
//
// claim_records is deliberately NOT restricted: approved claims are shared
// platform reference data (like error_catalogue), readable by all principals.
//
// Idempotent so it can be re-asserted on boot; `down` fully reverses it.

const BYPASS_ONLY_TABLES = ["clerk_cases", "clerk_inference_calls"];

const up = `
DROP TRIGGER IF EXISTS meridian_append_only ON clerk_inference_calls;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON clerk_inference_calls
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();

${BYPASS_ONLY_TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON ${t};
CREATE POLICY meridian_bypass_only ON ${t}
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');`,
).join("\n")}
`;

const down = `
${BYPASS_ONLY_TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_bypass_only ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}

DROP TRIGGER IF EXISTS meridian_append_only ON clerk_inference_calls;
`;

export const migration0005 = {
  version: 5,
  name: "clerk_guardrails",
  up,
  down,
};
