// Migration 0007 — recurring-invoice + deadline-reminder guardrails.
//
// Extends the firm-keyed row-level-security posture of migrations 0001/0002 to
// the two tables added for recurring invoices and automatic deadline
// reminders. recurring_invoice_templates is tenant CRUD data read and written
// through user routes (like invoices/bank_statements, which carry the same
// policy); deadline_reminder_sends is only ever touched by the bypass-context
// sweep today, but gets the same policy so an accidental future request-path
// query cannot leak across firms. Idempotent `up`, fully reversed by `down`
// (covered by the rollback test).

const TABLES = ["recurring_invoice_templates", "deadline_reminder_sends"];

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = `
${TABLES.map(
  (t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
CREATE POLICY meridian_tenant_isolation ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});`,
).join("\n")}
`;

const down = `
${TABLES.map(
  (t) => `DROP POLICY IF EXISTS meridian_tenant_isolation ON ${t};
ALTER TABLE ${t} NO FORCE ROW LEVEL SECURITY;
ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY;`,
).join("\n")}
`;

export const migration0007 = {
  version: 7,
  name: "recurring_reminder_guardrails",
  up,
  down,
};
