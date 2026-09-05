const ownerPolicy = (table: string) => `
ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_import_run_owner ON ${table};
CREATE POLICY meridian_import_run_owner ON ${table} USING (
  firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  AND actor_id = nullif(current_setting('app.operation_actor_id', true), '')
  AND (nullif(current_setting('app.operation_client_party_id', true), '') IS NULL
    OR client_party_id = nullif(current_setting('app.operation_client_party_id', true), '')::uuid)
) WITH CHECK (
  firm_id = nullif(current_setting('app.firm_id', true), '')::uuid
  AND actor_id = nullif(current_setting('app.operation_actor_id', true), '')
  AND (nullif(current_setting('app.operation_client_party_id', true), '') IS NULL
    OR client_party_id = nullif(current_setting('app.operation_client_party_id', true), '')::uuid)
);
`;

export const migration0054 = {
  version: 54,
  name: "import_runs",
  up: `
CREATE TABLE IF NOT EXISTS import_runs (
  id uuid NOT NULL,
  firm_id uuid NOT NULL REFERENCES firms(id),
  actor_id text NOT NULL,
  client_party_id uuid NOT NULL REFERENCES parties(id),
  manifest_hash text NOT NULL,
  total_rows integer NOT NULL,
  chunk_size integer NOT NULL,
  chunk_hashes jsonb NOT NULL,
  next_chunk_index integer NOT NULL DEFAULT 0,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_runs_pkey PRIMARY KEY (firm_id, actor_id, id)
);
CREATE TABLE IF NOT EXISTS import_run_chunks (
  firm_id uuid NOT NULL,
  actor_id text NOT NULL,
  run_id uuid NOT NULL,
  client_party_id uuid NOT NULL REFERENCES parties(id),
  chunk_index integer NOT NULL,
  operation_id uuid NOT NULL REFERENCES operations(id),
  row_count integer NOT NULL,
  created_count integer NOT NULL,
  invalid_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_run_chunks_pkey PRIMARY KEY (firm_id, actor_id, run_id, chunk_index),
  CONSTRAINT import_run_chunks_run_fk FOREIGN KEY (firm_id, actor_id, run_id) REFERENCES import_runs(firm_id, actor_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS import_run_chunks_operation_uidx ON import_run_chunks(operation_id);
-- Explicit bounds preserve pg_get_constraintdef text across pg_dump/restore.
ALTER TABLE import_runs DROP CONSTRAINT IF EXISTS import_runs_manifest_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_manifest_check CHECK (
  total_rows >= 1 AND total_rows <= 5000 AND chunk_size >= 1 AND chunk_size <= 250
  AND manifest_hash ~ '^[0-9a-f]{64}$' AND jsonb_typeof(chunk_hashes) = 'array'
  AND jsonb_array_length(chunk_hashes) = ((total_rows + chunk_size - 1) / chunk_size)
);
ALTER TABLE import_runs DROP CONSTRAINT IF EXISTS import_runs_checkpoint_check;
ALTER TABLE import_runs ADD CONSTRAINT import_runs_checkpoint_check CHECK (
  next_chunk_index >= 0 AND next_chunk_index <= jsonb_array_length(chunk_hashes)
  AND (finalized_at IS NULL OR next_chunk_index = jsonb_array_length(chunk_hashes))
);
ALTER TABLE import_run_chunks DROP CONSTRAINT IF EXISTS import_run_chunks_counts_check;
ALTER TABLE import_run_chunks ADD CONSTRAINT import_run_chunks_counts_check CHECK (
  chunk_index >= 0 AND row_count >= 1 AND row_count <= 250 AND created_count >= 0 AND invalid_count >= 0
  AND created_count + invalid_count = row_count
);
GRANT SELECT, INSERT, UPDATE ON import_runs TO meridian_app;
REVOKE DELETE ON import_runs FROM meridian_app;
GRANT SELECT, INSERT ON import_run_chunks TO meridian_app;
REVOKE UPDATE, DELETE ON import_run_chunks FROM meridian_app;
${ownerPolicy("import_runs")}
${ownerPolicy("import_run_chunks")}

CREATE OR REPLACE FUNCTION meridian_import_run_immutable() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.id, NEW.firm_id, NEW.actor_id, NEW.client_party_id, NEW.manifest_hash,
    NEW.total_rows, NEW.chunk_size, NEW.chunk_hashes, NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id, OLD.firm_id, OLD.actor_id, OLD.client_party_id, OLD.manifest_hash,
    OLD.total_rows, OLD.chunk_size, OLD.chunk_hashes, OLD.created_at)
    OR NEW.next_chunk_index NOT IN (OLD.next_chunk_index, OLD.next_chunk_index + 1)
    OR (OLD.finalized_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'import manifest and finalized run are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meridian_import_run_immutable ON import_runs;
CREATE TRIGGER meridian_import_run_immutable BEFORE UPDATE ON import_runs
  FOR EACH ROW EXECUTE FUNCTION meridian_import_run_immutable();

CREATE OR REPLACE FUNCTION meridian_import_chunk_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'import chunk outcomes are immutable' USING ERRCODE = '23514';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meridian_import_chunk_immutable ON import_run_chunks;
CREATE TRIGGER meridian_import_chunk_immutable BEFORE UPDATE OR DELETE ON import_run_chunks
  FOR EACH ROW EXECUTE FUNCTION meridian_import_chunk_immutable();

CREATE OR REPLACE FUNCTION meridian_import_run_checkpoint() RETURNS trigger AS $$
DECLARE r import_runs%ROWTYPE; n integer; covered integer;
BEGIN
  SELECT * INTO r FROM import_runs WHERE firm_id = NEW.firm_id AND actor_id = NEW.actor_id
    AND id = CASE WHEN TG_TABLE_NAME = 'import_runs' THEN (to_jsonb(NEW)->>'id')::uuid ELSE (to_jsonb(NEW)->>'run_id')::uuid END;
  SELECT count(*), coalesce(sum(row_count), 0) INTO n, covered FROM import_run_chunks
    WHERE firm_id = r.firm_id AND actor_id = r.actor_id AND run_id = r.id;
  IF n <> r.next_chunk_index OR covered <> least(r.next_chunk_index * r.chunk_size, r.total_rows)
    OR EXISTS (SELECT 1 FROM import_run_chunks c LEFT JOIN operations op ON op.id = c.operation_id
      WHERE c.firm_id = r.firm_id AND c.actor_id = r.actor_id AND c.run_id = r.id
      AND (op.id IS NULL OR c.chunk_index >= r.next_chunk_index OR c.client_party_id <> r.client_party_id
        OR c.row_count <> least(r.chunk_size, r.total_rows - c.chunk_index * r.chunk_size)
        OR op.firm_id <> r.firm_id OR op.actor_id <> r.actor_id OR op.client_party_id <> r.client_party_id
        OR op.command <> 'invoice.import' OR op.status = 'running'
        OR op.idempotency_key <> (r.id::text || ':' || c.chunk_index::text))) THEN
    RAISE EXCEPTION 'import checkpoint does not match committed chunks' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meridian_import_run_checkpoint ON import_runs;
CREATE CONSTRAINT TRIGGER meridian_import_run_checkpoint AFTER INSERT OR UPDATE ON import_runs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meridian_import_run_checkpoint();
DROP TRIGGER IF EXISTS meridian_import_chunk_checkpoint ON import_run_chunks;
CREATE CONSTRAINT TRIGGER meridian_import_chunk_checkpoint AFTER INSERT ON import_run_chunks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meridian_import_run_checkpoint();
`,
  down: `
DROP TRIGGER IF EXISTS meridian_import_chunk_checkpoint ON import_run_chunks;
DROP TRIGGER IF EXISTS meridian_import_run_checkpoint ON import_runs;
DROP FUNCTION IF EXISTS meridian_import_run_checkpoint();
DROP TRIGGER IF EXISTS meridian_import_chunk_immutable ON import_run_chunks;
DROP FUNCTION IF EXISTS meridian_import_chunk_immutable();
DROP TRIGGER IF EXISTS meridian_import_run_immutable ON import_runs;
DROP FUNCTION IF EXISTS meridian_import_run_immutable();
`,
};
