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

const bypassOnly = (table: string): string => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_bypass_only ON ${table};
CREATE POLICY meridian_bypass_only ON ${table}
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`;

const appendOnly = (table: string): string => `
DROP TRIGGER IF EXISTS meridian_append_only ON ${table};
CREATE TRIGGER meridian_append_only BEFORE UPDATE OR DELETE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION meridian_block_mutations();
`;

const removePolicy = (table: string, policy: string): string => `
DROP POLICY IF EXISTS ${policy} ON ${table};
ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
`;

const removeAppendOnly = (table: string): string =>
  `DROP TRIGGER IF EXISTS meridian_append_only ON ${table};\n`;

export const migration0049 = {
  version: 49,
  name: "credit_data_room_guardrails",
  up:
    // The v0 table remains for compatibility but no runtime can write it.
    bypassOnly("eligibility_assessments") +
    tenantPolicy("credit_eligibility_assessments") +
    tenantPolicy("credit_kyb_checks") +
    bypassOnly("credit_bank_access_events") +
    bypassOnly("credit_data_room_access_events") +
    bypassOnly("credit_backtest_runs") +
    // R4 money-moving tables remain unreachable even to firm sessions while
    // their code paths are dark and unimplemented.
    bypassOnly("financing_requests") +
    bypassOnly("facility_positions") +
    bypassOnly("repayment_events") +
    appendOnly("eligibility_assessments") +
    appendOnly("credit_eligibility_assessments") +
    appendOnly("credit_kyb_checks") +
    appendOnly("credit_bank_access_events") +
    appendOnly("credit_data_room_access_events") +
    appendOnly("credit_backtest_runs"),
  down:
    removeAppendOnly("credit_backtest_runs") +
    removeAppendOnly("credit_data_room_access_events") +
    removeAppendOnly("credit_bank_access_events") +
    removeAppendOnly("credit_kyb_checks") +
    removeAppendOnly("credit_eligibility_assessments") +
    removeAppendOnly("eligibility_assessments") +
    removePolicy("repayment_events", "meridian_bypass_only") +
    removePolicy("facility_positions", "meridian_bypass_only") +
    removePolicy("financing_requests", "meridian_bypass_only") +
    removePolicy("credit_backtest_runs", "meridian_bypass_only") +
    removePolicy("credit_data_room_access_events", "meridian_bypass_only") +
    removePolicy("credit_bank_access_events", "meridian_bypass_only") +
    removePolicy("credit_kyb_checks", "meridian_tenant_isolation") +
    removePolicy(
      "credit_eligibility_assessments",
      "meridian_tenant_isolation",
    ) +
    removePolicy("eligibility_assessments", "meridian_bypass_only"),
};
