import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { DrizzleQueryError, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { invoiceDraftsTable } from "../../../../../lib/db/src/schema/invoice-drafts.ts";
import { sweepExpiredInvoiceDraftContent } from "./retention.ts";
import { getDb, pool, runRequestContext, type PoolClient } from "@workspace/db";
import { migration0052 } from "../../../../../lib/db/src/migrations/0052_invoice_drafts.ts";
import type { Principal } from "../auth/rbac.ts";
import {
  deleteInvoiceDraft,
  getInvoiceDraft,
  listInvoiceDrafts,
  saveInvoiceDraft,
} from "./service.ts";

const firmId = randomUUID(),
  clientId = randomUUID(),
  siblingId = randomUUID();
const principal: Principal = {
  userId: randomUUID(),
  firmId,
  role: "client_user",
  clientPartyId: clientId,
  buyerPartyId: null,
};
const inTenant = <T>(fn: () => Promise<T>) =>
  runRequestContext({ bypass: false, firmId }, fn);
const content = (invoiceNumber = "DRAFT") => ({
  invoiceNumber,
  buyerPartyId: "",
  issueDate: "",
  dueDate: "",
  currency: "NGN",
  fxRateToNgn: "",
  whtCategory: "",
  lines: [{ description: "", quantity: "1", unitPrice: "", vatRate: "0" }],
});
const input = (expectedRevision = 0) => ({
  clientPartyId: clientId,
  expectedRevision,
  writeId: randomUUID(),
  draft: content(),
});

function isPermissionDenied(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const current = error as { code?: string; cause?: unknown };
    if (current.code === "42501") return true;
    error = current.cause;
  }
  return false;
}

// Fixtures use the disposable database's login role, never the request/worker role.
async function adminFixture<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let reusable = false;
  try {
    await client.query("BEGIN");
    const {
      rows: [role],
    } = await client.query(
      "SELECT current_user AS current_role, session_user AS login_role",
    );
    assert.equal(role.current_role, role.login_role);
    assert.notEqual(role.current_role, "meridian_app");
    const result = await fn(client);
    await client.query("COMMIT");
    reusable = true;
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
      reusable = true;
    } catch {
      /* A broken fixture connection must not reenter the pool. */
    }
    throw error;
  } finally {
    client.release(!reusable);
  }
}

test("DELETE denial assertion recognizes Drizzle's PostgreSQL cause, not arbitrary query failures", () => {
  const denied = Object.assign(
    new Error("permission denied for table invoice_drafts"),
    { code: "42501" },
  );
  const wrapped = new DrizzleQueryError(
    "DELETE FROM invoice_drafts WHERE firm_id = $1",
    [firmId],
    denied,
  );
  assert.doesNotMatch(wrapped.message, /permission denied/);
  assert.equal(isPermissionDenied(wrapped), true);
  assert.equal(isPermissionDenied(new Error("permission denied")), false);
  assert.equal(
    isPermissionDenied(
      new DrizzleQueryError(
        "DELETE FROM invoice_drafts",
        [],
        Object.assign(new Error("connection failure"), { code: "08006" }),
      ),
    ),
    false,
  );
});

test("draft recovery refuses an unscoped raw database write", async () => {
  await assert.rejects(
    saveInvoiceDraft(principal, randomUUID(), input()),
    /tenant transaction/,
  );
});

test("draft schema preserves migration RLS, owner policy and positive revision", () => {
  const config = getTableConfig(invoiceDraftsTable);
  assert.equal(config.enableRLS, true);
  const policy = config.policies.find(
    (p) => p.name === "meridian_tenant_isolation",
  )!;
  assert.ok(policy);
  const dialect = new PgDialect();
  const using = dialect.sqlToQuery(policy.using!).sql;
  assert.equal(using, dialect.sqlToQuery(policy.withCheck!).sql);
  for (const guc of [
    "app.bypass",
    "app.firm_id",
    "app.invoice_draft_user_id",
    "app.invoice_draft_client_id",
  ]) {
    assert.ok(using.includes(guc));
    assert.ok(migration0052.up.includes(guc));
  }
  assert.equal(config.checks[0].name, "invoice_drafts_revision_check");
  assert.match(dialect.sqlToQuery(config.checks[0].value).sql, /revision.*> 0/);
  assert.match(
    migration0052.up,
    /REVOKE DELETE ON invoice_drafts FROM meridian_app/,
  );
});

test("draft recovery rejects bypass roles with 403 before accessing the database", async () => {
  for (const role of [
    "operator",
    "auditor",
    "bank_user",
    "buyer_user",
  ] as const) {
    await assert.rejects(
      saveInvoiceDraft({ ...principal, role }, randomUUID(), input()),
      (error: unknown) =>
        error instanceof Error && "status" in error && error.status === 403,
    );
  }
});
describe(
  "invoice draft PostgreSQL ownership and concurrency",
  { skip: !process.env.DATABASE_URL, timeout: 60_000 },
  () => {
    before(async () => {
      await adminFixture(async (admin) => {
        await admin.query(migration0052.up);
        await admin.query(migration0052.up);
        const {
          rows: [permissions],
        } = await admin.query(
          "SELECT has_table_privilege(current_user, 'invoice_drafts', 'DELETE') AS fixture_delete, has_table_privilege('meridian_app', 'invoice_drafts', 'DELETE') AS runtime_delete",
        );
        assert.equal(
          permissions.fixture_delete,
          true,
          "fixture login must already have cleanup privileges",
        );
        assert.equal(
          permissions.runtime_delete,
          false,
          "runtime DELETE must remain revoked",
        );
        await admin.query(
          "INSERT INTO firms (id, name) VALUES ($1, 'Draft recovery fixture')",
          [firmId],
        );
        for (const id of [clientId, siblingId]) {
          await admin.query(
            "INSERT INTO parties (id, type, legal_name) VALUES ($1, 'client_business', 'Draft client')",
            [id],
          );
          await admin.query(
            "INSERT INTO engagements (firm_id, client_party_id, type, status, title) VALUES ($1, $2, 'retainer', 'open', 'Draft tests')",
            [firmId, id],
          );
        }
      });
    });
    after(async () => {
      await adminFixture(async (admin) => {
        await admin.query("DELETE FROM invoice_drafts WHERE firm_id = $1", [
          firmId,
        ]);
        await admin.query("DELETE FROM engagements WHERE firm_id = $1", [
          firmId,
        ]);
        await admin.query("DELETE FROM firms WHERE id = $1", [firmId]);
        await admin.query("DELETE FROM parties WHERE id = ANY($1::uuid[])", [
          [clientId, siblingId],
        ]);
      });
    });
    test("purges expired and discarded content but preserves tombstones and live drafts", async () => {
      const expiredId = randomUUID(),
        discardedId = randomUUID(),
        liveId = randomUUID();
      for (const id of [expiredId, discardedId, liveId]) {
        await inTenant(() => saveInvoiceDraft(principal, id, input()));
      }
      await inTenant(() =>
        deleteInvoiceDraft(principal, clientId, discardedId, 1),
      );
      const readRows = () =>
        adminFixture((admin) =>
          admin.query(
            "SELECT id, content, revision, write_id, expires_at, deleted_at FROM invoice_drafts WHERE firm_id = $1 AND id = ANY($2::uuid[]) ORDER BY id",
            [firmId, [expiredId, discardedId, liveId]],
          ),
        );
      await adminFixture(async (admin) => {
        await admin.query(
          "UPDATE invoice_drafts SET expires_at = now() - interval '1 day' WHERE firm_id = $1 AND id = $2",
          [firmId, expiredId],
        );
        // Current discard clears immediately; a legacy discarded row can still carry PII.
        await admin.query(
          "UPDATE invoice_drafts SET content = $3::jsonb WHERE firm_id = $1 AND id = $2",
          [firmId, discardedId, JSON.stringify(content())],
        );
      });
      const beforeSweep = await readRows();
      assert.equal(beforeSweep.rows.length, 3);
      for (const row of beforeSweep.rows)
        assert.deepEqual(row.content, content());
      await sweepExpiredInvoiceDraftContent();
      const result = await readRows();
      assert.equal(result.rows.length, 3);
      for (const id of [expiredId, discardedId]) {
        const row = result.rows.find((r) => r.id === id)!;
        assert.deepEqual(row.content, {});
        assert.ok(row.deleted_at);
        const before = beforeSweep.rows.find((r) => r.id === id)!;
        assert.equal(row.revision, before.revision);
        assert.equal(row.write_id, before.write_id);
        assert.deepEqual(row.expires_at, before.expires_at);
        if (id === discardedId)
          assert.deepEqual(row.deleted_at, before.deleted_at);
        await assert.rejects(
          inTenant(() => saveInvoiceDraft(principal, id, input())),
          /changed or was discarded/,
        );
      }
      assert.deepEqual(
        result.rows.find((r) => r.id === liveId),
        beforeSweep.rows.find((r) => r.id === liveId),
      );
      await assert.rejects(
        inTenant(async () => {
          await getDb().execute(
            sql`DELETE FROM invoice_drafts WHERE firm_id = ${firmId}::uuid`,
          );
        }),
        isPermissionDenied,
      );
      assert.deepEqual(
        (await readRows()).rows,
        result.rows,
        "denied DELETE must leave live content and tombstones untouched",
      );
      await sweepExpiredInvoiceDraftContent();
      assert.deepEqual(
        (await readRows()).rows,
        result.rows,
        "repeated retention sweep must be idempotent",
      );
    });
    test("supports multiple IDs and isolates another user and client", async () => {
      const id = randomUUID();
      await inTenant(() => saveInvoiceDraft(principal, id, input()));
      await inTenant(() => saveInvoiceDraft(principal, randomUUID(), input()));
      assert.equal(
        (await inTenant(() => listInvoiceDrafts(principal, clientId))).items
          .length >= 2,
        true,
      );
      await assert.rejects(
        inTenant(() =>
          getInvoiceDraft({ ...principal, userId: randomUUID() }, clientId, id),
        ),
        { status: 404 },
      );
      await assert.rejects(
        inTenant(() =>
          saveInvoiceDraft(principal, randomUUID(), {
            ...input(),
            clientPartyId: siblingId,
          }),
        ),
        { status: 403 },
      );
    });
    test("concurrent writes with one revision have exactly one winner", async () => {
      const id = randomUUID();
      await inTenant(() => saveInvoiceDraft(principal, id, input()));
      const writes = await Promise.allSettled(
        ["A", "B"].map((name) =>
          inTenant(() =>
            saveInvoiceDraft(principal, id, {
              ...input(1),
              draft: content(name),
            }),
          ),
        ),
      );
      assert.equal(
        writes.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const failure = writes.find((result) => result.status === "rejected");
      assert.equal(
        failure?.status === "rejected" && failure.reason.status,
        409,
      );
      assert.equal(
        (await inTenant(() => getInvoiceDraft(principal, clientId, id)))
          .revision,
        2,
      );
    });
    test("replaying an acknowledged write does not increment revision and mismatched reuse conflicts", async () => {
      const id = randomUUID(),
        command = input();
      const first = await inTenant(() =>
        saveInvoiceDraft(principal, id, command),
      );
      assert.deepEqual(
        await inTenant(() => saveInvoiceDraft(principal, id, command)),
        first,
      );
      await assert.rejects(
        inTenant(() =>
          saveInvoiceDraft(principal, id, {
            ...command,
            draft: content("different"),
          }),
        ),
        { status: 409 },
      );
    });
    test("a discard tombstone blocks late insert-only writes and stale deletions", async () => {
      const id = randomUUID();
      await inTenant(() => deleteInvoiceDraft(principal, clientId, id, 0));
      await assert.rejects(
        inTenant(() => saveInvoiceDraft(principal, id, input())),
        { status: 409 },
      );
      const other = randomUUID();
      await inTenant(() => saveInvoiceDraft(principal, other, input()));
      await assert.rejects(
        inTenant(() => deleteInvoiceDraft(principal, clientId, other, 0)),
        { status: 409 },
      );
      await inTenant(() => deleteInvoiceDraft(principal, clientId, other, 1));
      await assert.rejects(
        inTenant(() => getInvoiceDraft(principal, clientId, other)),
        { status: 404 },
      );
    });
    test("RLS itself hides drafts when another actor GUC is bound", async () => {
      const id = randomUUID();
      await inTenant(() => saveInvoiceDraft(principal, id, input()));
      await inTenant(async () => {
        await getDb().execute(
          sql`SELECT set_config('app.invoice_draft_user_id', ${randomUUID()}, true), set_config('app.invoice_draft_client_id', ${clientId}, true)`,
        );
        const rows = await getDb().execute(
          sql`SELECT id FROM invoice_drafts WHERE id = ${id}::uuid`,
        );
        assert.equal(rows.rows.length, 0);
      });
    });
    test("outer transaction rollback leaves neither a draft nor an acknowledged revision", async () => {
      const id = randomUUID();
      await assert.rejects(
        inTenant(async () => {
          await saveInvoiceDraft(principal, id, input());
          throw new Error("rollback");
        }),
        /rollback/,
      );
      await assert.rejects(
        inTenant(() => getInvoiceDraft(principal, clientId, id)),
        { status: 404 },
      );
    });
  },
);
