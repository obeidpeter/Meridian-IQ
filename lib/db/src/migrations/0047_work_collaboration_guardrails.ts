// Collaboration rows carry firm_id and therefore use the standard tenant RLS
// boundary. Client-party isolation is narrower than a PostgreSQL session's
// firm context and is enforced again in routes/work.ts for every client-user
// read and write.

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const policy = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const unpolicy = (table: string): string => `
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

export const migration0047 = {
  version: 47,
  name: "work_collaboration_guardrails",
  up:
    policy("work_items") +
    policy("work_item_comments") +
    `
DROP TRIGGER IF EXISTS meridian_append_only ON work_item_comments;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON work_item_comments
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();
`,
  down:
    `DROP TRIGGER IF EXISTS meridian_append_only ON work_item_comments;\n` +
    unpolicy("work_item_comments") +
    unpolicy("work_items"),
};
