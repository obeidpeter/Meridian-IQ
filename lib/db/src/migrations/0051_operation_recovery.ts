export const migration0051 = {
  version: 51,
  name: "operation_recovery",
  up: `
CREATE TABLE IF NOT EXISTS operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id),
  actor_id text NOT NULL,
  client_party_id uuid NOT NULL REFERENCES parties(id),
  command text NOT NULL,
  idempotency_key text NOT NULL,
  payload_hash text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  response_status integer,
  response_body text,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS operations_command_key_uidx
  ON operations (firm_id, actor_id, command, idempotency_key);
CREATE INDEX IF NOT EXISTS operations_owner_history_idx
  ON operations (firm_id, actor_id, created_at, id);
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_command_check;
ALTER TABLE operations ADD CONSTRAINT operations_command_check
  CHECK (command IN ('invoice.create', 'invoice.import'));
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_key_check;
ALTER TABLE operations ADD CONSTRAINT operations_key_check
  CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_hash_check;
ALTER TABLE operations ADD CONSTRAINT operations_hash_check
  CHECK (payload_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE operations DROP CONSTRAINT IF EXISTS operations_result_check;
ALTER TABLE operations ADD CONSTRAINT operations_result_check CHECK (
  (status = 'running' AND response_status IS NULL AND response_body IS NULL) OR
  (status IN ('succeeded', 'partial', 'failed') AND response_status IS NOT NULL
    AND response_status BETWEEN 200 AND 299 AND response_body IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE ON operations TO meridian_app;
REVOKE DELETE ON operations FROM meridian_app;
ALTER TABLE operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meridian_operation_owner ON operations;
CREATE POLICY meridian_operation_owner ON operations USING (
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

CREATE OR REPLACE FUNCTION meridian_operation_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'running' OR
    ROW(NEW.id, NEW.firm_id, NEW.actor_id, NEW.client_party_id, NEW.command,
        NEW.idempotency_key, NEW.payload_hash, NEW.created_at) IS DISTINCT FROM
    ROW(OLD.id, OLD.firm_id, OLD.actor_id, OLD.client_party_id, OLD.command,
        OLD.idempotency_key, OLD.payload_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'operation result and identity are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meridian_operation_immutable ON operations;
CREATE TRIGGER meridian_operation_immutable BEFORE UPDATE ON operations
  FOR EACH ROW EXECUTE FUNCTION meridian_operation_immutable();

-- A reservation must never survive independently of its command's result.
CREATE OR REPLACE FUNCTION meridian_operation_complete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM operations WHERE id = NEW.id AND status = 'running') THEN
    RAISE EXCEPTION 'cannot commit an unfinished operation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS meridian_operation_complete ON operations;
CREATE CONSTRAINT TRIGGER meridian_operation_complete AFTER INSERT OR UPDATE ON operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION meridian_operation_complete();
`,
  // Recovery results are durable records: a rollback removes guards, not data.
  down: `
DROP TRIGGER IF EXISTS meridian_operation_complete ON operations;
DROP FUNCTION IF EXISTS meridian_operation_complete();
DROP TRIGGER IF EXISTS meridian_operation_immutable ON operations;
DROP FUNCTION IF EXISTS meridian_operation_immutable();
`,
};
