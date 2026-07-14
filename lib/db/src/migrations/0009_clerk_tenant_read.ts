// Migration 0009 — Clerk goes client-facing (Clerk expansion A).
//
// 0005 made clerk_cases and clerk_inference_calls bypass-only: Clerk was an
// operator tool and the tables hold cross-tenant PII. With client capture and
// firm Ask Clerk, firm principals must now read/write THEIR OWN rows, so the
// bypass-only policy is widened to firm-keyed-or-bypass — the same posture as
// every tenant table (0001), keeping cross-firm isolation at the data layer.
// Sub-tenant (client_user) narrowing stays at the route layer via createdBy,
// exactly like SEC-03 elsewhere. The 0005 append-only trigger on the ledger is
// untouched. Idempotent `up`, reversed by `down` (rollback-test covered).

const CLERK_TABLES = ["clerk_cases", "clerk_inference_calls"];

const FIRM_MATCH =
  "firm_id = nullif(current_setting('app.firm_id', true), '')::uuid";

const up = CLERK_TABLES.map(
  (t) => `
DROP POLICY IF EXISTS meridian_bypass_only ON ${t};
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${t};
CREATE POLICY meridian_clerk_tenant ON ${t}
  USING (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH})
  WITH CHECK (current_setting('app.bypass', true) = 'on' OR ${FIRM_MATCH});
`,
).join("\n");

const down = CLERK_TABLES.map(
  (t) => `
DROP POLICY IF EXISTS meridian_clerk_tenant ON ${t};
CREATE POLICY meridian_bypass_only ON ${t}
  USING (current_setting('app.bypass', true) = 'on')
  WITH CHECK (current_setting('app.bypass', true) = 'on');
`,
).join("\n");

export const migration0009 = {
  version: 9,
  name: "clerk_tenant_read",
  up,
  down,
};
