import assert from "node:assert/strict";
import { test, after } from "node:test";
import { pool, closeDatabasePools } from "@workspace/db";
import { assertEvidenceGuardrails } from "./evidence-guardrails";

after(() => closeDatabasePools());

test("production evidence catalog gate rejects missing and disabled database guardrails", async () => {
  assert.ok(
    process.env.DATABASE_URL,
    "a migrated disposable database is required",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assertEvidenceGuardrails(client);
    const mutations = [
      [
        "GRANT DELETE ON evidence_requests TO meridian_app",
        "privilege:evidence_requests/DELETE",
      ],
      [
        "GRANT DELETE ON evidence_files TO meridian_app",
        "privilege:evidence_files/DELETE",
      ],
      [
        "GRANT UPDATE ON evidence_events TO meridian_app",
        "privilege:evidence_events/UPDATE",
      ],
      [
        "GRANT UPDATE (comment) ON evidence_events TO meridian_app",
        "privilege:evidence_events/UPDATE",
      ],
      [
        "GRANT DELETE ON evidence_events TO meridian_app",
        "privilege:evidence_events/DELETE",
      ],
      [
        "REVOKE INSERT ON evidence_events FROM meridian_app",
        "privilege:evidence_events/INSERT",
      ],
      [
        "ALTER TYPE public.message_channel RENAME VALUE 'in_app' TO 'evidence_catalog_probe'",
        "enum:message_channel.in_app",
      ],
      [
        "ALTER TABLE evidence_files DROP CONSTRAINT evidence_files_valid_sha256",
        "constraint:evidence_files_valid_sha256",
      ],
      [
        "ALTER TABLE evidence_events DROP CONSTRAINT evidence_events_request_file_fk",
        "foreign-key:evidence_events_request_file_fk",
      ],
      [
        `ALTER TABLE evidence_events DROP CONSTRAINT evidence_events_request_file_fk;
        ALTER TABLE evidence_events ADD CONSTRAINT evidence_events_request_file_fk
          FOREIGN KEY (file_id) REFERENCES evidence_files (id) DEFERRABLE INITIALLY DEFERRED`,
        "foreign-key:evidence_events_request_file_fk",
      ],
      [
        "DROP INDEX evidence_events_request_command_uq",
        "index:evidence_events_request_command_uq",
      ],
      [
        "ALTER TABLE evidence_files DISABLE TRIGGER meridian_evidence_file_guard",
        "trigger:evidence_files/meridian_evidence_file_guard",
      ],
      [
        `DROP TRIGGER meridian_evidence_file_guard ON evidence_files;
        CREATE TRIGGER meridian_evidence_file_guard BEFORE UPDATE OF filename OR DELETE
          ON evidence_files FOR EACH ROW EXECUTE FUNCTION meridian_evidence_file_guard()`,
        "trigger:evidence_files/meridian_evidence_file_guard",
      ],
      [
        "DROP TRIGGER meridian_append_only ON evidence_events",
        "trigger:evidence_events/meridian_append_only",
      ],
      [
        "DELETE FROM _schema_migrations WHERE version = 57",
        "migration:evidence_hub_guardrails",
      ],
      [
        "ALTER FUNCTION meridian_evidence_request_guard() SECURITY DEFINER",
        "trigger:evidence_requests/meridian_evidence_request_guard",
      ],
    ];
    for (const [sql, issue] of mutations) {
      await client.query("SAVEPOINT evidence_catalog_drift");
      await client.query(sql);
      await assert.rejects(
        assertEvidenceGuardrails(client),
        (error: unknown) =>
          error instanceof Error && error.message.includes(issue),
      );
      await client.query("ROLLBACK TO SAVEPOINT evidence_catalog_drift");
      await client.query("RELEASE SAVEPOINT evidence_catalog_drift");
      await assertEvidenceGuardrails(client);
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
});
