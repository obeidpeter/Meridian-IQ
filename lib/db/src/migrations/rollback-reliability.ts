import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";

interface Probe {
  desc: string;
  expect: boolean;
  check: (pool: pg.Pool) => Promise<boolean>;
}
const sqlProbe = (
  desc: string,
  sql: string,
  values: unknown[] = [],
  expect = true,
): Probe => ({
  desc,
  expect,
  check: async (pool) =>
    (await pool.query<{ ok: boolean }>(sql, values)).rows[0]?.ok === true,
});
const column = (table: string, name: string, expect = true) =>
  sqlProbe(
    `${table}.${name} exists`,
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2) AS ok",
    [table, name],
    expect,
  );
const index = (name: string, expect = true) =>
  sqlProbe(
    `${name} index is ready and valid`,
    "SELECT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid=to_regclass($1) AND indisvalid AND indisready) AS ok",
    [`public.${name}`],
    expect,
  );
const trigger = (table: string, name: string, expect = true) =>
  sqlProbe(
    `${table}.${name} trigger is enabled`,
    "SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass($1) AND tgname=$2 AND tgenabled IN ('O','A')) AS ok",
    [`public.${table}`, name],
    expect,
  );
const secured = (table: string, policy: string) =>
  sqlProbe(
    `${table} retains enforced RLS and ${policy}`,
    "SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_policy p ON p.polrelid=c.oid WHERE n.nspname='public' AND c.relname=$1 AND c.relrowsecurity AND c.relforcerowsecurity AND p.polname=$2) AS ok",
    [table, policy],
  );
const fn = (name: string, expect = true) =>
  sqlProbe(
    `${name} function exists`,
    "SELECT to_regprocedure($1) IS NOT NULL AS ok",
    [`public.${name}()`],
    expect,
  );
const grants = (table: string, update = true) =>
  sqlProbe(
    `${table} keeps only its reviewed runtime DML grants`,
    "SELECT ARRAY(SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('meridian_app', $1, p) ORDER BY p) = $2::text[] AS ok",
    [
      `public.${table}`,
      update ? ["INSERT", "SELECT", "UPDATE"] : ["INSERT", "SELECT"],
    ],
  );

export const RELIABILITY_LADDER = [
  {
    version: 50,
    atTop: [
      column("invoices", "content_revision"),
      column("invoice_approvals", "content_revision"),
      index("invoice_approvals_live_revision_idx"),
      index("invoice_lines_number_uidx"),
      sqlProbe(
        "invoice revisions have a validated positive constraint",
        "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname='invoice_content_revision_positive' AND convalidated AND pg_get_constraintdef(oid) LIKE '%content_revision > 0%') AS ok",
      ),
    ],
    afterRollback: [
      column("invoices", "content_revision"),
      column("invoice_approvals", "content_revision"),
      index("invoice_approvals_live_revision_idx"),
      index("invoice_lines_number_uidx"),
      sqlProbe(
        "revision constraint remains validated during application rollback",
        "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.invoices'::regclass AND conname='invoice_content_revision_positive' AND convalidated AND pg_get_constraintdef(oid) LIKE '%content_revision > 0%') AS ok",
      ),
    ],
  },
  {
    version: 51,
    atTop: [
      secured("operations", "meridian_operation_owner"),
      grants("operations"),
      index("operations_command_key_uidx"),
      trigger("operations", "meridian_operation_immutable"),
      trigger("operations", "meridian_operation_complete"),
    ],
    afterRollback: [
      secured("operations", "meridian_operation_owner"),
      grants("operations"),
      index("operations_command_key_uidx"),
      trigger("operations", "meridian_operation_immutable", false),
      trigger("operations", "meridian_operation_complete", false),
      fn("meridian_operation_immutable", false),
      fn("meridian_operation_complete", false),
    ],
  },
  {
    version: 52,
    atTop: [
      secured("invoice_drafts", "meridian_tenant_isolation"),
      grants("invoice_drafts"),
      index("invoice_drafts_owner_idx"),
      index("invoice_drafts_expiry_idx"),
    ],
    afterRollback: [
      secured("invoice_drafts", "meridian_tenant_isolation"),
      grants("invoice_drafts"),
      index("invoice_drafts_owner_idx"),
      index("invoice_drafts_expiry_idx"),
    ],
  },
  {
    version: 53,
    atTop: [
      secured("clerk_reservations", "meridian_bypass_only"),
      grants("clerk_reservations"),
      index("clerk_reservations_unsettled_idx"),
    ],
    afterRollback: [
      secured("clerk_reservations", "meridian_bypass_only"),
      grants("clerk_reservations"),
      index("clerk_reservations_unsettled_idx"),
    ],
  },
  {
    version: 54,
    atTop: [
      secured("import_runs", "meridian_import_run_owner"),
      secured("import_run_chunks", "meridian_import_run_owner"),
      grants("import_runs"),
      grants("import_run_chunks", false),
      index("import_run_chunks_operation_uidx"),
      trigger("import_runs", "meridian_import_run_immutable"),
      trigger("import_run_chunks", "meridian_import_chunk_immutable"),
      trigger("import_runs", "meridian_import_run_checkpoint"),
      trigger("import_run_chunks", "meridian_import_chunk_checkpoint"),
    ],
    afterRollback: [
      secured("import_runs", "meridian_import_run_owner"),
      secured("import_run_chunks", "meridian_import_run_owner"),
      grants("import_runs"),
      grants("import_run_chunks", false),
      index("import_run_chunks_operation_uidx"),
      trigger("import_runs", "meridian_import_run_immutable", false),
      trigger("import_run_chunks", "meridian_import_chunk_immutable", false),
      trigger("import_runs", "meridian_import_run_checkpoint", false),
      trigger("import_run_chunks", "meridian_import_chunk_checkpoint", false),
      fn("meridian_import_run_immutable", false),
      fn("meridian_import_chunk_immutable", false),
      fn("meridian_import_run_checkpoint", false),
    ],
  },
];

export async function reliabilityRollbackFixtures(pool: pg.Pool) {
  const firm = randomUUID();
  const party = randomUUID();
  const invoice = randomUUID();
  const approval = randomUUID();
  const legacyApproval = randomUUID();
  const line = randomUUID();
  const operation = randomUUID();
  const draft = randomUUID();
  const reservation = randomUUID();
  const run = randomUUID();
  const importOperation = randomUUID();
  await pool.query(
    "INSERT INTO firms (id,name) VALUES ($1,'Rollback fixture')",
    [firm],
  );
  await pool.query(
    "INSERT INTO parties (id,type,legal_name) VALUES ($1,'client_business','Rollback fixture')",
    [party],
  );
  await pool.query(
    "INSERT INTO invoices (id,firm_id,supplier_party_id,buyer_party_id,invoice_number,issue_date) VALUES ($1,$2,$3,$3,$4,'2026-09-04')",
    [invoice, firm, party, `ROLLBACK-${invoice}`],
  );
  await pool.query(
    "INSERT INTO invoice_approvals (id,firm_id,invoice_id,approved_by_user_id,content_revision,note) VALUES ($1,$2,$3,'rollback-actor',1,'Retain approval evidence')",
    [approval, firm, invoice],
  );
  await pool.query(
    "INSERT INTO invoice_approvals (id,firm_id,invoice_id,approved_by_user_id,note) VALUES ($1,$2,$3,'legacy-actor','Legacy approval has no revision binding')",
    [legacyApproval, firm, invoice],
  );
  await pool.query(
    "INSERT INTO invoice_lines (id,invoice_id,line_no,description,quantity,unit_price,line_extension) VALUES ($1,$2,1,'Retained line',1,42,42)",
    [line, invoice],
  );
  const assertUniqueLine = async () => {
    await assert.rejects(
      pool.query(
        "INSERT INTO invoice_lines (invoice_id,line_no,description,quantity,unit_price,line_extension) VALUES ($1,1,'Duplicate line',1,42,42)",
        [invoice],
      ),
      (error: unknown) =>
        (error as { code?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint ===
          "invoice_lines_number_uidx",
      "invoice line identity is enforced by the specific unique index",
    );
  };
  await assertUniqueLine();
  await pool.query(
    `INSERT INTO operations (id,firm_id,actor_id,client_party_id,command,idempotency_key,payload_hash,status,response_status,response_body)
    VALUES ($1::uuid,$2,'rollback-actor',$3,'invoice.create',($1::uuid)::text,$4,'succeeded',201,'{"retained":true}')`,
    [operation, firm, party, "a".repeat(64)],
  );
  await pool.query(
    `INSERT INTO invoice_drafts (firm_id,user_id,client_party_id,id,write_id,content,expires_at)
    VALUES ($1,'rollback-actor',$2,$3,$4,'{"invoiceNumber":"retained"}',now()+interval '1 day')`,
    [firm, party, draft, randomUUID()],
  );
  await pool.query(
    `INSERT INTO clerk_reservations (id,firm_id,reserved_tokens,month_start,expires_at)
    VALUES ($1,$2,42,date_trunc('month',now()),now()+interval '1 day')`,
    [reservation, firm],
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO operations (id,firm_id,actor_id,client_party_id,command,idempotency_key,payload_hash,status,response_status,response_body)
      VALUES ($1,$2,'rollback-actor',$3,'invoice.import',$4,$5,'succeeded',200,'{"retained":true}')`,
      [importOperation, firm, party, `${run}:0`, "b".repeat(64)],
    );
    await client.query(
      `INSERT INTO import_runs (id,firm_id,actor_id,client_party_id,manifest_hash,total_rows,chunk_size,chunk_hashes,next_chunk_index,finalized_at)
      VALUES ($1,$2,'rollback-actor',$3,$4,1,1,$5::jsonb,1,now())`,
      [run, firm, party, "a".repeat(64), JSON.stringify(["b".repeat(64)])],
    );
    await client.query(
      `INSERT INTO import_run_chunks (firm_id,actor_id,run_id,client_party_id,chunk_index,operation_id,row_count,created_count,invalid_count)
      VALUES ($1,'rollback-actor',$2,$3,0,$4,1,1,0)`,
      [firm, run, party, importOperation],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  // PostgreSQL jsonb snapshots preserve all values, including timestamps and IDs.
  const snapshots = new Map<
    number,
    { table: string; id: string; row: unknown }
  >();
  for (const [version, table, id] of [
    [51, "operations", operation],
    [52, "invoice_drafts", draft],
    [53, "clerk_reservations", reservation],
  ] as const) {
    const row = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM ${table} t WHERE id=$1`,
        [id],
      )
    ).rows[0]?.row;
    assert.ok(row, `${table} rollback fixture inserted`);
    snapshots.set(version, { table, id, row });
  }
  const invoiceBefore = (
    await pool.query("SELECT to_jsonb(t) AS row FROM invoices t WHERE id=$1", [
      invoice,
    ])
  ).rows[0].row;
  const approvalBefore = (
    await pool.query(
      "SELECT to_jsonb(t) AS row FROM invoice_approvals t WHERE id=$1",
      [approval],
    )
  ).rows[0].row;
  const lineBefore = (
    await pool.query(
      "SELECT to_jsonb(t) AS row FROM invoice_lines t WHERE id=$1",
      [line],
    )
  ).rows[0].row;
  const runBefore = (
    await pool.query(
      "SELECT to_jsonb(t) AS row FROM import_runs t WHERE id=$1",
      [run],
    )
  ).rows[0].row;
  const chunkBefore = (
    await pool.query(
      "SELECT to_jsonb(t) AS row FROM import_run_chunks t WHERE run_id=$1",
      [run],
    )
  ).rows[0].row;

  // Real SQL failures prove these are enforced constraints, not decorative DDL.
  for (const [sql, values] of [
    ["UPDATE invoices SET content_revision=0 WHERE id=$1", [invoice]],
    ["UPDATE operations SET response_body='tampered' WHERE id=$1", [operation]],
    ["UPDATE invoice_drafts SET revision=0 WHERE id=$1", [draft]],
    [
      "UPDATE clerk_reservations SET reserved_tokens=0 WHERE id=$1",
      [reservation],
    ],
    ["UPDATE import_runs SET total_rows=2 WHERE id=$1", [run]],
    ["UPDATE import_run_chunks SET created_count=0 WHERE run_id=$1", [run]],
  ] as const) {
    await assert.rejects(
      pool.query(sql, [...values]),
      (error: unknown) => (error as { code?: string }).code === "23514",
      sql,
    );
  }

  // Deferred triggers must reject inconsistent state at COMMIT, not just UPDATE.
  for (const [sql, values] of [
    [
      "INSERT INTO operations (firm_id,actor_id,client_party_id,command,idempotency_key,payload_hash) VALUES ($1,'rollback-actor',$2,'invoice.create',$3,$4)",
      [firm, party, randomUUID(), "c".repeat(64)],
    ],
    [
      "INSERT INTO import_runs (id,firm_id,actor_id,client_party_id,manifest_hash,total_rows,chunk_size,chunk_hashes,next_chunk_index) VALUES ($1,$2,'rollback-actor',$3,$4,1,1,$5::jsonb,1)",
      [
        randomUUID(),
        firm,
        party,
        "c".repeat(64),
        JSON.stringify(["c".repeat(64)]),
      ],
    ],
  ] as const) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(sql, [...values]);
      await assert.rejects(
        connection.query("COMMIT"),
        (error: unknown) => (error as { code?: string }).code === "23514",
        "incomplete durable work must not commit",
      );
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }

  async function visible(
    table: string,
    column: string,
    id: string,
    overrides: Record<string, string> = {},
  ) {
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL ROLE meridian_app");
      const settings = {
        "app.bypass": "off",
        "app.firm_id": firm,
        "app.operation_actor_id": "rollback-actor",
        "app.operation_client_party_id": party,
        "app.invoice_draft_user_id": "rollback-actor",
        "app.invoice_draft_client_id": party,
        ...overrides,
      };
      for (const [key, value] of Object.entries(settings))
        await connection.query("SELECT set_config($1,$2,true)", [key, value]);
      return (
        await connection.query(
          `SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,
          [id],
        )
      ).rows[0].count as number;
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }

  const afterRollback = async (version: number) => {
    if (version === 50) {
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_jsonb(t) AS row FROM invoices t WHERE id=$1",
            [invoice],
          )
        ).rows[0]?.row,
        invoiceBefore,
        "revision rollback preserves invoice financial/legal evidence",
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_jsonb(t) AS row FROM invoice_approvals t WHERE id=$1",
            [approval],
          )
        ).rows[0]?.row,
        approvalBefore,
        "revision rollback preserves approval evidence",
      );
      await assertUniqueLine();
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_jsonb(t) AS row FROM invoice_lines t WHERE invoice_id=$1 ORDER BY line_no",
            [invoice],
          )
        ).rows.map((row) => row.row),
        [lineBefore],
        "rollback preserves the original line with no duplicate side effects",
      );
    }
    if (version === 54) {
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_jsonb(t) AS row FROM import_runs t WHERE id=$1",
            [run],
          )
        ).rows[0]?.row,
        runBefore,
        "import manifest/checkpoint survives rollback",
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT to_jsonb(t) AS row FROM import_run_chunks t WHERE run_id=$1",
            [run],
          )
        ).rows[0]?.row,
        chunkBefore,
        "committed import chunk outcome survives rollback",
      );
    }
    const snapshot = snapshots.get(version);
    if (snapshot) {
      assert.deepEqual(
        (
          await pool.query(
            `SELECT to_jsonb(t) AS row FROM ${snapshot.table} t WHERE id=$1`,
            [snapshot.id],
          )
        ).rows[0]?.row,
        snapshot.row,
        `migration ${version} down preserves every durable fixture value`,
      );
    }
    const ownerTables =
      version === 51
        ? [["operations", "id", operation]]
        : version === 54
          ? [
              ["import_runs", "id", run],
              ["import_run_chunks", "run_id", run],
            ]
          : [];
    for (const [table, key, id] of ownerTables) {
      assert.equal(
        await visible(table, key, id),
        1,
        `${table}: owner retains access after rollback`,
      );
      for (const overrides of [
        { "app.firm_id": randomUUID() },
        { "app.operation_actor_id": "other-actor" },
        { "app.operation_actor_id": "" },
        { "app.operation_client_party_id": randomUUID() },
        { "app.bypass": "on", "app.operation_actor_id": "other-actor" },
      ] as Record<string, string>[]) {
        assert.equal(
          await visible(table, key, id, overrides),
          0,
          `${table}: cross-owner data stays hidden after rollback`,
        );
      }
    }
    if (version === 52) {
      assert.equal(await visible("invoice_drafts", "id", draft), 1);
      for (const overrides of [
        { "app.firm_id": randomUUID() },
        { "app.invoice_draft_user_id": "other" },
        { "app.invoice_draft_client_id": randomUUID() },
      ] as Record<string, string>[]) {
        assert.equal(
          await visible("invoice_drafts", "id", draft, overrides),
          0,
          "draft ownership stays enforced after rollback",
        );
      }
    }
    if (version === 53) {
      assert.equal(
        await visible("clerk_reservations", "id", reservation),
        0,
        "firm sessions cannot read spend reservations",
      );
      assert.equal(
        await visible("clerk_reservations", "id", reservation, {
          "app.bypass": "on",
        }),
        1,
        "worker can reconcile retained spend after rollback",
      );
    }
  };
  return {
    afterRollback,
    afterReapply: async () => {
      const preserved = (
        await pool.query(
          "SELECT content_revision, revoked_at, note FROM invoice_approvals WHERE id=$1",
          [approval],
        )
      ).rows[0];
      assert.equal(
        preserved?.revoked_at,
        null,
        "re-applying revision migration does not revoke an already revision-bound approval",
      );
      assert.equal(
        preserved.content_revision,
        1,
        "the exact reviewed revision survives rollback and reapply",
      );
      assert.equal(preserved.note, "Retain approval evidence");
      await afterRollback(50);
      const legacy = (
        await pool.query(
          "SELECT content_revision, revoked_at, note FROM invoice_approvals WHERE id=$1",
          [legacyApproval],
        )
      ).rows[0];
      assert.ok(
        legacy?.revoked_at,
        "genuinely legacy approvals are revoked on upgrade",
      );
      assert.equal(legacy.content_revision, null);
      assert.equal(legacy.note, "Legacy approval has no revision binding");
    },
  };
}
