// Pilot publication does not run the governed release's complete manifest-to-DB
// comparison. Check these additive controls before exposing evidence endpoints.
export const EVIDENCE_GUARDRAIL_CATALOG_SQL = `
WITH required_privileges(table_name, allowed) AS (VALUES
  ('evidence_requests', ARRAY['SELECT', 'INSERT', 'UPDATE']),
  ('evidence_files', ARRAY['SELECT', 'INSERT', 'UPDATE']),
  ('evidence_events', ARRAY['SELECT', 'INSERT'])
), required_checks(table_name, name) AS (VALUES
  ('evidence_requests', 'evidence_requests_one_anchor'),
  ('evidence_requests', 'evidence_requests_valid_period'),
  ('evidence_requests', 'evidence_requests_positive_version'),
  ('evidence_requests', 'evidence_requests_acceptance_pointer'),
  ('evidence_requests', 'evidence_requests_unaccepted_pointer'),
  ('evidence_requests', 'evidence_requests_requested_pointer'),
  ('evidence_requests', 'evidence_requests_uploaded_pointer'),
  ('evidence_files', 'evidence_files_valid_byte_size'),
  ('evidence_files', 'evidence_files_supported_content_type'),
  ('evidence_files', 'evidence_files_valid_sha256')
), required_fks(table_name, name, columns, parent_name, parent_columns, deferred) AS (VALUES
  ('evidence_files', 'evidence_files_request_firm_fk', ARRAY['firm_id', 'request_id'], 'evidence_requests', ARRAY['firm_id', 'id'], false),
  ('evidence_events', 'evidence_events_request_firm_fk', ARRAY['firm_id', 'request_id'], 'evidence_requests', ARRAY['firm_id', 'id'], false),
  ('evidence_requests', 'evidence_requests_latest_file_fk', ARRAY['id', 'latest_file_id'], 'evidence_files', ARRAY['request_id', 'id'], true),
  ('evidence_requests', 'evidence_requests_accepted_file_fk', ARRAY['id', 'accepted_file_id'], 'evidence_files', ARRAY['request_id', 'id'], true),
  ('evidence_events', 'evidence_events_request_file_fk', ARRAY['request_id', 'file_id'], 'evidence_files', ARRAY['request_id', 'id'], true)
), required_indexes(table_name, name, columns) AS (VALUES
  ('evidence_requests', 'evidence_requests_firm_command_uq', ARRAY['firm_id', 'client_request_id']),
  ('evidence_requests', 'evidence_requests_firm_id_uq', ARRAY['firm_id', 'id']),
  ('evidence_files', 'evidence_files_request_command_uq', ARRAY['request_id', 'client_request_id']),
  ('evidence_files', 'evidence_files_request_id_uq', ARRAY['request_id', 'id']),
  ('evidence_events', 'evidence_events_request_command_uq', ARRAY['request_id', 'client_request_id'])
), required_triggers(table_name, name, function_name, trigger_type, columns) AS (VALUES
  ('evidence_requests', 'meridian_evidence_request_guard', 'meridian_evidence_request_guard', 23, ARRAY[]::text[]),
  ('evidence_files', 'meridian_evidence_file_guard', 'meridian_evidence_file_guard', 27, ARRAY[]::text[]),
  ('evidence_events', 'meridian_append_only', 'meridian_evidence_event_guard', 27, ARRAY[]::text[]),
  ('invoices', 'meridian_evidence_invoice_anchor_guard', 'meridian_evidence_invoice_anchor_guard', 19, ARRAY['id', 'firm_id', 'supplier_party_id']),
  ('filing_returns', 'meridian_evidence_filing_anchor_guard', 'meridian_evidence_filing_anchor_guard', 19, ARRAY['id', 'firm_id', 'client_party_id'])
)
SELECT 'migration:evidence_hub_guardrails' AS issue
  WHERE NOT EXISTS (SELECT 1 FROM public._schema_migrations
    WHERE version = 57 AND name = 'evidence_hub_guardrails')
UNION ALL
SELECT 'privilege:' || r.table_name || '/' || privilege FROM required_privileges r
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
  WHERE has_table_privilege('meridian_app', to_regclass('public.' || r.table_name), privilege)
    IS DISTINCT FROM (privilege = ANY(r.allowed))
    OR (NOT (privilege = ANY(r.allowed)) AND CASE
      WHEN privilege IN ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
        THEN has_any_column_privilege('meridian_app', to_regclass('public.' || r.table_name), privilege)
      ELSE false END)
UNION ALL
SELECT 'enum:message_channel.in_app'
  WHERE NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'message_channel' AND e.enumlabel = 'in_app')
UNION ALL
SELECT 'constraint:' || r.name FROM required_checks r
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.' || r.table_name)
      AND c.conname = r.name AND c.contype = 'c' AND c.convalidated)
UNION ALL
SELECT 'foreign-key:' || r.name FROM required_fks r
  WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public.' || r.table_name)
      AND c.confrelid = to_regclass('public.' || r.parent_name)
      AND c.conname = r.name AND c.contype = 'f' AND c.convalidated
      AND c.condeferrable = r.deferred AND c.condeferred = r.deferred
      AND c.confupdtype = 'a' AND c.confdeltype = 'a' AND c.confmatchtype = 's'
      AND ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.num ORDER BY k.ord) = r.columns
      AND ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.num ORDER BY k.ord) = r.parent_columns)
UNION ALL
SELECT 'index:' || r.name FROM required_indexes r
  WHERE NOT EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.' || r.name)
      AND i.indrelid = to_regclass('public.' || r.table_name)
      AND i.indisvalid AND i.indisready AND i.indisunique AND i.indimmediate AND i.indpred IS NULL
      AND i.indexprs IS NULL
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.num ORDER BY k.ord) = r.columns)
UNION ALL
SELECT 'trigger:' || r.table_name || '/' || r.name FROM required_triggers r
  WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE t.tgrelid = to_regclass('public.' || r.table_name) AND t.tgname = r.name
      AND NOT t.tgisinternal AND t.tgenabled IN ('O', 'A') AND t.tgtype = r.trigger_type
      AND t.tgqual IS NULL AND p.proname = r.function_name AND n.nspname = 'public'
      AND NOT p.prosecdef AND 'search_path=pg_catalog, public' = ANY(p.proconfig)
      AND ARRAY(SELECT a.attname::text FROM unnest(t.tgattr::smallint[]) WITH ORDINALITY k(num, ord)
        JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.num ORDER BY k.ord) = r.columns)
ORDER BY issue;
`;

interface CatalogReader {
  query(sql: string): Promise<{ rows: { issue: string }[] }>;
}

export async function assertEvidenceGuardrails(
  reader: CatalogReader,
): Promise<void> {
  const { rows } = await reader.query(EVIDENCE_GUARDRAIL_CATALOG_SQL);
  if (rows.length > 0) {
    throw new Error(
      `Evidence Hub guardrails incomplete: ${rows.map((row) => row.issue).join(", ")}`,
    );
  }
}
