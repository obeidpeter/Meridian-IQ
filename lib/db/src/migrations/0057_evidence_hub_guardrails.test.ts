import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migration0057 } from "./0057_evidence_hub_guardrails.ts";
import { applyGuardrailMigrations } from "./index.ts";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
before(async () => {
  assert.equal(
    process.env.E2E_DATABASE_DISPOSABLE,
    "1",
    "migration setup requires an explicitly disposable database",
  );
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL must target a disposable migration-test database",
  );
  const result = await applyGuardrailMigrations(pool, [migration0057]);
  assert.deepEqual(
    result.skipped,
    [],
    "the Evidence Hub migration must apply before its guardrails are tested",
  );
});
after(() => pool.end());

type Fixture = Awaited<ReturnType<typeof seed>>;

async function seed(client: pg.PoolClient) {
  const firm = randomUUID();
  const otherFirm = randomUUID();
  const party = randomUUID();
  const otherParty = randomUUID();
  const user = randomUUID();
  const otherUser = randomUUID();
  const invoice = randomUUID();
  const filing = randomUUID();
  await client.query(
    "INSERT INTO firms (id, name) VALUES ($1, 'Evidence guardrail'), ($2, 'Other evidence firm')",
    [firm, otherFirm],
  );
  await client.query(
    "INSERT INTO parties (id, type, legal_name) VALUES ($1, 'client_business', 'Evidence client'), ($2, 'client_business', 'Other evidence client')",
    [party, otherParty],
  );
  await client.query(
    "INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)",
    [
      user,
      `${user}@evidence.invalid`,
      otherUser,
      `${otherUser}@evidence.invalid`,
    ],
  );
  await client.query(
    `INSERT INTO invoices (id, firm_id, supplier_party_id, buyer_party_id, invoice_number, issue_date)
    VALUES ($1, $2, $3, $4, $5, '2026-09-01')`,
    [invoice, firm, party, otherParty, invoice],
  );
  await client.query(
    `INSERT INTO filing_returns (id, firm_id, client_party_id, tax_type, period, due_date)
    VALUES ($1, $2, $3, 'vat', '2026-08', '2026-09-21')`,
    [filing, firm, party],
  );
  return {
    firm,
    otherFirm,
    party,
    otherParty,
    user,
    otherUser,
    invoice,
    filing,
  };
}

async function fixture(
  run: (client: pg.PoolClient, data: Fixture) => Promise<void>,
) {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL must target a disposable migration-test database",
  );
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL app.bypass = 'on'");
    await run(client, await seed(client));
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function rejectWrite(
  client: pg.PoolClient,
  code: string,
  run: () => Promise<unknown>,
) {
  await client.query("SAVEPOINT rejected_evidence_write");
  try {
    await assert.rejects(
      run(),
      (error: unknown) => (error as { code?: string }).code === code,
    );
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT rejected_evidence_write");
    await client.query("RELEASE SAVEPOINT rejected_evidence_write");
  }
}

async function request(
  client: pg.PoolClient,
  data: Fixture,
  overrides: {
    firm?: string;
    party?: string;
    invoice?: string | null;
    filing?: string | null;
    period?: string | null;
    version?: number;
  } = {},
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO evidence_requests
    (id, firm_id, client_party_id, invoice_id, filing_id, period, title, document_type,
      owner_id, created_by, version, client_request_id, request_hash)
    VALUES ($1, $2, $3, $4, $5, $6, 'Supporting document', 'other', $7, $7, $8, $9, $10)`,
    [
      id,
      overrides.firm ?? data.firm,
      overrides.party ?? data.party,
      overrides.invoice ?? null,
      overrides.filing ?? null,
      Object.hasOwn(overrides, "period") ? overrides.period : "2026-09",
      data.user,
      overrides.version ?? 1,
      randomUUID(),
      "a".repeat(64),
    ],
  );
  return id;
}

async function file(
  client: pg.PoolClient,
  data: Fixture,
  requestId: string,
  firmId = data.firm,
  metadata: { byteSize?: number; contentType?: string; sha256?: string } = {},
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO evidence_files
    (id, firm_id, request_id, filename, content_type, byte_size, sha256,
      encrypted_content, uploaded_by, client_request_id, request_hash)
    VALUES ($1, $2, $3, 'receipt.pdf', $7, $8, $4, 'encrypted-fixture', $5, $6, $4)`,
    [
      id,
      firmId,
      requestId,
      metadata.sha256 ?? "b".repeat(64),
      data.user,
      randomUUID(),
      metadata.contentType ?? "application/pdf",
      metadata.byteSize ?? 42,
    ],
  );
  return id;
}

async function event(
  client: pg.PoolClient,
  data: Fixture,
  requestId: string,
  fileId: string | null = null,
  firmId = data.firm,
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO evidence_events (id, firm_id, request_id, actor_id, action, file_id)
    VALUES ($1, $2, $3, $4, 'uploaded', $5)`,
    [id, firmId, requestId, data.user, fileId],
  );
  return id;
}

test("migration 57 is idempotent and retains validated guardrails on rollback", async () =>
  fixture(async (client) => {
    await client.query(migration0057.up);
    await client.query(migration0057.up);
    await client.query(migration0057.down);
    const policies =
      await client.query(`SELECT tablename, cmd, qual = with_check AS symmetric
    FROM pg_policies WHERE schemaname = 'public' AND tablename LIKE 'evidence_%' ORDER BY tablename`);
    assert.deepEqual(policies.rows, [
      { tablename: "evidence_events", cmd: "ALL", symmetric: true },
      { tablename: "evidence_files", cmd: "ALL", symmetric: true },
      { tablename: "evidence_requests", cmd: "ALL", symmetric: true },
    ]);
    const rls =
      await client.query(`SELECT relname, relrowsecurity, relforcerowsecurity
    FROM pg_class WHERE oid IN ('evidence_requests'::regclass, 'evidence_files'::regclass, 'evidence_events'::regclass)`);
    assert.ok(
      rls.rows.every((row) => row.relrowsecurity && row.relforcerowsecurity),
    );
    const privileges = await client.query(`SELECT table_name, ARRAY(
      SELECT privilege FROM unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) privilege
      WHERE has_table_privilege('meridian_app', to_regclass('public.' || table_name), privilege)
    ) AS grants FROM unnest(ARRAY['evidence_events', 'evidence_files', 'evidence_requests']) table_name ORDER BY table_name`);
    assert.deepEqual(
      privileges.rows,
      [
        { table_name: "evidence_events", grants: ["SELECT", "INSERT"] },
        {
          table_name: "evidence_files",
          grants: ["SELECT", "INSERT", "UPDATE"],
        },
        {
          table_name: "evidence_requests",
          grants: ["SELECT", "INSERT", "UPDATE"],
        },
      ],
      "least-privilege grants survive migration replays and application rollback",
    );
    const constraints = await client.query<{
      conname: string;
      convalidated: boolean;
      condeferrable: boolean;
      condeferred: boolean;
    }>(
      `SELECT conname, convalidated, condeferrable, condeferred
    FROM pg_constraint WHERE conname = ANY($1) ORDER BY conname`,
      [
        [
          "evidence_requests_one_anchor",
          "evidence_requests_valid_period",
          "evidence_requests_positive_version",
          "evidence_requests_acceptance_pointer",
          "evidence_requests_unaccepted_pointer",
          "evidence_requests_requested_pointer",
          "evidence_requests_uploaded_pointer",
          "evidence_files_valid_byte_size",
          "evidence_files_supported_content_type",
          "evidence_files_valid_sha256",
          "evidence_files_request_firm_fk",
          "evidence_events_request_firm_fk",
          "evidence_requests_latest_file_fk",
          "evidence_requests_accepted_file_fk",
          "evidence_events_request_file_fk",
        ],
      ],
    );
    assert.equal(constraints.rows.length, 15);
    assert.ok(constraints.rows.every((row) => row.convalidated));
    for (const name of [
      "evidence_requests_latest_file_fk",
      "evidence_requests_accepted_file_fk",
      "evidence_events_request_file_fk",
    ]) {
      const constraint = constraints.rows.find((row) => row.conname === name)!;
      assert.ok(constraint.condeferrable && constraint.condeferred, name);
    }
    const triggers = await client.query(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY($1)`,
      [
        [
          "meridian_evidence_request_guard",
          "meridian_evidence_file_guard",
          "meridian_evidence_invoice_anchor_guard",
          "meridian_evidence_filing_anchor_guard",
        ],
      ],
    );
    assert.equal(triggers.rows.length, 4);
    assert.ok(triggers.rows.every((row) => row.tgenabled === "O"));
    const functions =
      await client.query(`SELECT proname, prosecdef, proconfig FROM pg_proc
    WHERE proname LIKE 'meridian_evidence_%'`);
    assert.equal(functions.rows.length, 5);
    assert.ok(
      functions.rows.every(
        (row) =>
          !row.prosecdef &&
          row.proconfig.includes("search_path=pg_catalog, public"),
      ),
    );
  }));

test("evidence requests require exactly one valid anchor and a positive version", async () =>
  fixture(async (client, data) => {
    for (const overrides of [
      { period: null },
      { period: "2026-09", invoice: data.invoice },
      { period: null, invoice: data.invoice, filing: data.filing },
      { period: "2026-00" },
      { period: "2026-13" },
      { period: "0000-01" },
      { period: "2026-9" },
      { period: "2026-09-extra" },
      { version: 0 },
      { version: -1 },
    ])
      await rejectWrite(client, "23514", () =>
        request(client, data, overrides),
      );
    await request(client, data, { period: "0001-01" });
    await request(client, data, { period: "9999-12" });
    await request(client, data, { period: null, invoice: data.invoice });
    await request(client, data, { period: null, filing: data.filing });
  }));

test("evidence invoice and filing anchors must match the firm and client on both sides", async () =>
  fixture(async (client, data) => {
    for (const anchor of [{ invoice: data.invoice }, { filing: data.filing }]) {
      await rejectWrite(client, "23514", () =>
        request(client, data, {
          ...anchor,
          period: null,
          firm: data.otherFirm,
        }),
      );
      await rejectWrite(client, "23514", () =>
        request(client, data, {
          ...anchor,
          period: null,
          party: data.otherParty,
        }),
      );
      await request(client, data, { ...anchor, period: null });
    }
    await rejectWrite(client, "23514", () =>
      client.query("UPDATE invoices SET supplier_party_id = $1 WHERE id = $2", [
        data.otherParty,
        data.invoice,
      ]),
    );
    await rejectWrite(client, "23514", () =>
      client.query("UPDATE invoices SET firm_id = $1 WHERE id = $2", [
        data.otherFirm,
        data.invoice,
      ]),
    );
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE filing_returns SET client_party_id = $1 WHERE id = $2",
        [data.otherParty, data.filing],
      ),
    );
    await rejectWrite(client, "23514", () =>
      client.query("UPDATE filing_returns SET firm_id = $1 WHERE id = $2", [
        data.otherFirm,
        data.filing,
      ]),
    );
  }));

test("request identity, scope, anchor, creator and command provenance are immutable", async () =>
  fixture(async (client, data) => {
    const id = await request(client, data);
    const changes = [
      ["id", randomUUID()],
      ["firm_id", data.otherFirm],
      ["client_party_id", data.otherParty],
      ["invoice_id", data.invoice],
      ["filing_id", data.filing],
      ["period", "2026-08"],
      ["created_by", data.otherUser],
      ["created_at", "2026-01-01T00:00:00Z"],
      ["client_request_id", randomUUID()],
      ["request_hash", "c".repeat(64)],
    ];
    for (const [column, value] of changes) {
      await rejectWrite(client, "23514", () =>
        client.query(
          `UPDATE evidence_requests SET ${client.escapeIdentifier(column)} = $1 WHERE id = $2`,
          [value, id],
        ),
      );
    }
    await client.query(
      `UPDATE evidence_requests SET title = 'Clarified request', owner_id = $1,
    due_at = now() + interval '1 day', version = version + 1, last_reminder_at = now() WHERE id = $2`,
      [data.otherUser, id],
    );
  }));

test("files and events cannot cross firms or reference another request's file", async () =>
  fixture(async (client, data) => {
    const first = await request(client, data);
    const second = await request(client, data);
    const firstFile = await file(client, data, first);
    await rejectWrite(client, "23503", () =>
      file(client, data, first, data.otherFirm),
    );
    await rejectWrite(client, "23503", () =>
      event(client, data, first, null, data.otherFirm),
    );
    for (const write of [
      () =>
        client.query(
          "UPDATE evidence_requests SET latest_file_id = $1, status = 'uploaded' WHERE id = $2",
          [firstFile, second],
        ),
      () => event(client, data, second, firstFile),
    ]) {
      await rejectWrite(client, "23503", async () => {
        await write();
        await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      });
    }
    await event(client, data, first, firstFile);
    await client.query(
      "UPDATE evidence_requests SET latest_file_id = $1, status = 'uploaded' WHERE id = $2",
      [firstFile, first],
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
  }));

test("stored file versions allow scanner updates only and review events remain append-only", async () =>
  fixture(async (client, data) => {
    const requestId = await request(client, data);
    const fileId = await file(client, data, requestId);
    const eventId = await event(client, data, requestId, fileId);
    const changes = [
      ["id", randomUUID()],
      ["firm_id", data.otherFirm],
      ["request_id", randomUUID()],
      ["filename", "replaced.pdf"],
      ["content_type", "image/png"],
      ["byte_size", "43"],
      ["sha256", "c".repeat(64)],
      ["encrypted_content", "replacement"],
      ["uploaded_by", data.otherUser],
      ["client_request_id", randomUUID()],
      ["request_hash", "c".repeat(64)],
      ["created_at", "2026-01-01T00:00:00Z"],
    ];
    for (const [column, value] of changes) {
      await rejectWrite(client, "23514", () =>
        client.query(
          `UPDATE evidence_files SET ${client.escapeIdentifier(column)} = $1 WHERE id = $2`,
          [value, fileId],
        ),
      );
    }
    await client.query(
      `UPDATE evidence_files SET scan_attempts = 1, scan_token = $1,
    next_scan_at = now(), lease_until = now() + interval '1 minute', scan_error = 'Scanner unavailable'
    WHERE id = $2`,
      [randomUUID(), fileId],
    );
    await client.query(
      "UPDATE evidence_files SET scan_status = 'clean', scanned_at = now(), scan_error = NULL, scan_token = NULL, lease_until = NULL WHERE id = $1",
      [fileId],
    );
    await client.query("SET LOCAL app.allow_purge = 'on'");
    await rejectWrite(client, "23514", () =>
      client.query("DELETE FROM evidence_files WHERE id = $1", [fileId]),
    );
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_events SET comment = 'Changed history' WHERE id = $1",
        [eventId],
      ),
    );
    await rejectWrite(client, "23514", () =>
      client.query("DELETE FROM evidence_events WHERE id = $1", [eventId]),
    );
  }));

test("acceptance requires the latest clean version and prevents later unsafe scan status", async () =>
  fixture(async (client, data) => {
    const requestId = await request(client, data);
    const firstFile = await file(client, data, requestId);
    const latestFile = await file(client, data, requestId);
    await client.query(
      "UPDATE evidence_requests SET latest_file_id = $1, status = 'uploaded' WHERE id = $2",
      [latestFile, requestId],
    );
    const accept = (id: string | null) =>
      client.query(
        "UPDATE evidence_requests SET status = 'accepted', accepted_file_id = $1 WHERE id = $2",
        [id, requestId],
      );
    await rejectWrite(client, "23514", () => accept(null));
    await rejectWrite(client, "23514", () => accept(latestFile));
    await client.query(
      "UPDATE evidence_files SET scan_status = 'rejected', scanned_at = now() WHERE id = $1",
      [latestFile],
    );
    await rejectWrite(client, "23514", () => accept(latestFile));
    await client.query(
      "UPDATE evidence_files SET scan_status = 'clean', scanned_at = now() WHERE request_id = $1",
      [requestId],
    );
    await rejectWrite(client, "23514", () => accept(firstFile));
    await accept(latestFile);
    await client.query(
      `INSERT INTO evidence_events (firm_id, request_id, actor_id, action, file_id)
      VALUES ($1, $2, $3, 'accepted', $4)`,
      [data.firm, requestId, data.user, latestFile],
    );
    for (const status of ["quarantined", "rejected"]) {
      await rejectWrite(client, "23514", () =>
        client.query(
          "UPDATE evidence_files SET scan_status = $1 WHERE id = $2",
          [status, latestFile],
        ),
      );
    }
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_requests SET latest_file_id = $1 WHERE id = $2",
        [firstFile, requestId],
      ),
    );
    // Reopening the request does not silently revoke the accepted version's safety.
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_requests SET status = 'needs_changes' WHERE id = $1",
        [requestId],
      ),
    );
    await client.query(
      "UPDATE evidence_requests SET status = 'needs_changes', accepted_file_id = NULL WHERE id = $1",
      [requestId],
    );
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_files SET scan_status = 'quarantined' WHERE id = $1",
        [latestFile],
      ),
    );
  }));

test("file intake constraints enforce supported types, bounded sizes and canonical digests", async () =>
  fixture(async (client, data) => {
    const requestId = await request(client, data);
    for (const metadata of [
      { byteSize: 0 },
      { byteSize: -1 },
      { byteSize: 5242881 },
      { contentType: "text/html" },
      { contentType: "image/svg+xml" },
      { contentType: "application/pdf; charset=utf-8" },
      { sha256: "" },
      { sha256: "b".repeat(63) },
      { sha256: "b".repeat(65) },
      { sha256: "B".repeat(64) },
      { sha256: "z".repeat(64) },
    ]) {
      await rejectWrite(client, "23514", () =>
        file(client, data, requestId, data.firm, metadata),
      );
    }
    for (const contentType of ["application/pdf", "image/png", "image/jpeg"]) {
      await file(client, data, requestId, data.firm, {
        contentType,
        byteSize: 1,
      });
      await file(client, data, requestId, data.firm, {
        contentType,
        byteSize: 5242880,
      });
    }
  }));

test("request status and file pointers cannot contradict one another", async () =>
  fixture(async (client, data) => {
    const requestId = await request(client, data);
    const fileId = await file(client, data, requestId);
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_requests SET latest_file_id = $1 WHERE id = $2",
        [fileId, requestId],
      ),
    );
    await rejectWrite(client, "23514", () =>
      client.query(
        "UPDATE evidence_requests SET status = 'uploaded' WHERE id = $1",
        [requestId],
      ),
    );
    for (const status of [
      "requested",
      "uploaded",
      "needs_changes",
      "cancelled",
    ]) {
      await rejectWrite(client, "23514", () =>
        client.query(
          "UPDATE evidence_requests SET status = $1, latest_file_id = $2, accepted_file_id = $2 WHERE id = $3",
          [status, fileId, requestId],
        ),
      );
    }
    await client.query(
      "UPDATE evidence_requests SET status = 'uploaded', latest_file_id = $1 WHERE id = $2",
      [fileId, requestId],
    );
  }));

test("all three evidence tables enforce tenant reads and writes with the restricted runtime role", async () =>
  fixture(async (client, data) => {
    const first = await request(client, data);
    const second = await request(client, data, {
      firm: data.otherFirm,
      party: data.otherParty,
    });
    const firstFile = await file(client, data, first);
    const secondFile = await file(client, data, second, data.otherFirm);
    const firstEvent = await event(client, data, first, firstFile);
    const secondEvent = await event(
      client,
      data,
      second,
      secondFile,
      data.otherFirm,
    );
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("SET LOCAL ROLE meridian_app");
    await client.query(
      "SELECT set_config('app.firm_id', $1, true), set_config('app.bypass', 'off', true)",
      [data.firm],
    );
    for (const [table, own, other] of [
      ["evidence_requests", first, second],
      ["evidence_files", firstFile, secondFile],
      ["evidence_events", firstEvent, secondEvent],
    ]) {
      const result = await client.query(
        `SELECT id FROM ${client.escapeIdentifier(table)} WHERE id IN ($1, $2)`,
        [own, other],
      );
      assert.deepEqual(result.rows, [{ id: own }]);
      await rejectWrite(client, "42501", () =>
        client.query(
          `DELETE FROM ${client.escapeIdentifier(table)} WHERE id = $1`,
          [own],
        ),
      );
    }
    await rejectWrite(client, "42501", () =>
      client.query(
        "UPDATE evidence_events SET comment = 'Forbidden history rewrite' WHERE id = $1",
        [firstEvent],
      ),
    );
    await rejectWrite(client, "42501", () =>
      request(client, data, { firm: data.otherFirm }),
    );
    await rejectWrite(client, "42501", () =>
      file(client, data, second, data.otherFirm),
    );
    await rejectWrite(client, "42501", () =>
      event(client, data, second, null, data.otherFirm),
    );
    const hiddenUpdate = await client.query(
      "UPDATE evidence_requests SET title = 'Other tenant write' WHERE id = $1",
      [second],
    );
    assert.equal(hiddenUpdate.rowCount, 0);
    await client.query("SELECT set_config('app.firm_id', '', true)");
    for (const table of [
      "evidence_requests",
      "evidence_files",
      "evidence_events",
    ]) {
      const result = await client.query(
        `SELECT id FROM ${client.escapeIdentifier(table)} WHERE firm_id = $1`,
        [data.firm],
      );
      assert.equal(result.rowCount, 0, "missing tenant context fails closed");
    }
  }));
