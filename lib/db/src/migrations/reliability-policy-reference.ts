import type pg from "pg";

// Independently reviewed policy contracts, not imported from migration.up.
// Render through PostgreSQL so casts/parentheses are canonical on the CI major.
// Altering a migration cannot silently regenerate its own expected predicate.
const OWNER_MATCH = `firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  AND actor_id = nullif(current_setting('app.operation_actor_id', true), '')
  AND (nullif(current_setting('app.operation_client_party_id', true), '') IS NULL
    OR client_party_id = nullif(current_setting('app.operation_client_party_id', true), '')::uuid)`;
export const OWNER_ONLY_POLICIES = new Set([
  "operations/meridian_operation_owner",
  "import_runs/meridian_import_run_owner",
  "import_run_chunks/meridian_import_run_owner",
]);
const REVIEWED: Record<string, string> = {
  "operations/meridian_operation_owner": OWNER_MATCH,
  "import_runs/meridian_import_run_owner": OWNER_MATCH,
  "import_run_chunks/meridian_import_run_owner": OWNER_MATCH,
  "invoice_drafts/meridian_tenant_isolation": `current_setting('app.bypass', true) = 'on' OR (
    firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
    AND user_id = current_setting('app.invoice_draft_user_id', true)
    AND client_party_id = nullif(current_setting('app.invoice_draft_client_id', true), '')::uuid)`,
  "clerk_reservations/meridian_bypass_only":
    "current_setting('app.bypass', true) = 'on'",
};

export async function reliabilityPolicyPins(
  pool: pg.Pool,
  hash: (text: string) => string,
) {
  const client = await pool.connect();
  const pins: Record<
    string,
    { cmd: string; roles: string; qual: string; withCheck: string }
  > = {};
  try {
    await client.query("BEGIN");
    await client.query(
      "CREATE TEMP TABLE r198_policy_reference (firm_id uuid, actor_id text, client_party_id uuid, user_id text) ON COMMIT DROP",
    );
    for (const [key, expression] of Object.entries(REVIEWED)) {
      await client.query(
        `CREATE POLICY reviewed ON r198_policy_reference USING (${expression}) WITH CHECK (${expression})`,
      );
      const result = await client.query<{
        qual: string;
        with_check: string;
      }>(`SELECT pg_get_expr(polqual, polrelid) AS qual,
        pg_get_expr(polwithcheck, polrelid) AS with_check FROM pg_policy WHERE polrelid='pg_temp.r198_policy_reference'::regclass`);
      const row = result.rows[0];
      pins[key] = {
        cmd: "ALL",
        roles: "public",
        qual: hash(row.qual),
        withCheck: hash(row.with_check),
      };
      await client.query("DROP POLICY reviewed ON r198_policy_reference");
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  return pins;
}
