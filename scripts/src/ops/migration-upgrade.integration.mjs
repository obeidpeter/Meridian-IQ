import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { psql } from "./common.mjs";
import { CATALOG_SQL, compareSecurityCatalog } from "./security-catalog.mjs";
import { migration0050 } from "../../../lib/db/src/migrations/0050_invoice_revisions.ts";
import { migration0051 } from "../../../lib/db/src/migrations/0051_operation_recovery.ts";
import { migration0052 } from "../../../lib/db/src/migrations/0052_invoice_drafts.ts";
import { migration0053 } from "../../../lib/db/src/migrations/0053_clerk_reservations.ts";
import { migration0054 } from "../../../lib/db/src/migrations/0054_import_runs.ts";
import { migration0055 } from "../../../lib/db/src/migrations/0055_production_bootstrap_claims.ts";

test("migration-only R198 upgrade matches scratch schema semantics and preserves financial rows", () => {
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "disposable PostgreSQL is mandatory",
  );
  assert.ok(
    process.env.DATABASE_URL,
    "real PostgreSQL DATABASE_URL is required",
  );
  const firm = randomUUID(),
    party = randomUUID(),
    invoice = randomUUID();
  const migrations = [
    migration0050,
    migration0051,
    migration0052,
    migration0053,
    migration0054,
    migration0055,
  ];
  // This is an explicit pre-R198 fixture, not an inferred/general down migration.
  // All destructive setup and replay occur in one transaction that never commits.
  const result = psql(
    process.env.DATABASE_URL,
    `
    BEGIN;
    SET LOCAL search_path = public, pg_catalog;
    SET LOCAL statement_timeout = '60s';
    SET LOCAL lock_timeout = '5s';
    DO $$ BEGIN
      IF (SELECT max(version) FROM _schema_migrations) <> 55 THEN
        RAISE EXCEPTION 'upgrade fixture requires the reviewed 0055 baseline';
      END IF;
    END $$;
    INSERT INTO firms(id,name) VALUES ('${firm}','Migration-only fixture');
    INSERT INTO parties(id,type,legal_name) VALUES ('${party}','client_business','Migration-only fixture');
    INSERT INTO invoices(id,firm_id,supplier_party_id,buyer_party_id,invoice_number,issue_date,subtotal,grand_total)
      VALUES ('${invoice}','${firm}','${party}','${party}','UPGRADE-${invoice}','2026-09-04',42,42);
    INSERT INTO invoice_lines(invoice_id,line_no,description,quantity,unit_price,line_extension)
      VALUES ('${invoice}',1,'Retained upgrade line',1,42,42);
    CREATE TEMP TABLE pre_invoice_evidence AS SELECT to_jsonb(i)-'content_revision' AS row FROM invoices i;
    CREATE TEMP TABLE pre_line_evidence AS SELECT to_jsonb(l) AS row FROM invoice_lines l;
    ${CATALOG_SQL}
    ${migration0055.down}
    ${migration0054.down}
    ${migration0051.down}
    DROP TABLE import_run_chunks, import_runs, operations, invoice_drafts, clerk_reservations;
    ALTER TABLE invoice_approvals DROP COLUMN content_revision;
    ALTER TABLE invoices DROP COLUMN content_revision;
    DROP INDEX invoice_lines_number_uidx;
    DELETE FROM _schema_migrations WHERE version BETWEEN 50 AND 55;
    ${migrations
      .map(
        (migration) => `${migration.up}
      INSERT INTO _schema_migrations(version,name) VALUES (${migration.version},'${migration.name}');`,
      )
      .join("\n")}
    DO $$ BEGIN
      IF EXISTS (
        (SELECT row FROM pre_invoice_evidence EXCEPT SELECT to_jsonb(i)-'content_revision' FROM invoices i)
        UNION ALL
        (SELECT to_jsonb(i)-'content_revision' FROM invoices i EXCEPT SELECT row FROM pre_invoice_evidence)
      ) OR EXISTS (
        (SELECT row FROM pre_line_evidence EXCEPT SELECT to_jsonb(l) FROM invoice_lines l)
        UNION ALL
        (SELECT to_jsonb(l) FROM invoice_lines l EXCEPT SELECT row FROM pre_line_evidence)
      ) THEN RAISE EXCEPTION 'migration-only upgrade changed financial data'; END IF;
    END $$;
    ${CATALOG_SQL}
    ROLLBACK;
  `,
  );
  const catalogs = result
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  assert.equal(
    catalogs.length,
    2,
    "both real PostgreSQL catalogs were captured",
  );
  compareSecurityCatalog(catalogs[0], catalogs[1]);
});
