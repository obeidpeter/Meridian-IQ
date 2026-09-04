const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const tenantPolicy = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
CREATE POLICY meridian_tenant_isolation ON ${table}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`;

const untenant = (table: string): string => `
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

const bypassOnly = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON ${table};
CREATE POLICY meridian_bypass_only ON ${table}
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

export const migration0048 = {
  version: 48,
  name: "invoice_room_guardrails",
  up:
    tenantPolicy("invoice_room_shares") +
    bypassOnly("invoice_room_sessions") +
    tenantPolicy("invoice_room_events") +
    tenantPolicy("invoice_room_payment_requests") +
    `
DROP TRIGGER IF EXISTS meridian_append_only ON invoice_room_events;
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON invoice_room_events
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();
`,
  down:
    `DROP TRIGGER IF EXISTS meridian_append_only ON invoice_room_events;\n` +
    untenant("invoice_room_payment_requests") +
    untenant("invoice_room_events") +
    `DROP POLICY IF EXISTS meridian_bypass_only ON invoice_room_sessions;
ALTER TABLE invoice_room_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_room_sessions DISABLE ROW LEVEL SECURITY;
` +
    untenant("invoice_room_shares"),
};
