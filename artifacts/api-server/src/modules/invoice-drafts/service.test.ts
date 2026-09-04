import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { invoiceDraftsTable } from "../../../../../lib/db/src/schema/invoice-drafts.ts";
import { sweepExpiredInvoiceDraftContent } from "./retention.ts";
import { getDb, pool, runRequestContext } from "@workspace/db";
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
      await pool.query(migration0052.up);
      await pool.query(migration0052.up);
      await pool.query(
        "INSERT INTO firms (id, name) VALUES ($1, 'Draft recovery fixture')",
        [firmId],
      );
      for (const id of [clientId, siblingId]) {
        await pool.query(
          "INSERT INTO parties (id, type, legal_name) VALUES ($1, 'client_business', 'Draft client')",
          [id],
        );
        await pool.query(
          "INSERT INTO engagements (firm_id, client_party_id, type, status, title) VALUES ($1, $2, 'retainer', 'open', 'Draft tests')",
          [firmId, id],
        );
      }
    });
    after(async () => {
      await pool.query("DELETE FROM invoice_drafts WHERE firm_id = $1", [
        firmId,
      ]);
      await pool.query("DELETE FROM engagements WHERE firm_id = $1", [firmId]);
      await pool.query("DELETE FROM firms WHERE id = $1", [firmId]);
      await pool.query("DELETE FROM parties WHERE id = ANY($1::uuid[])", [
        [clientId, siblingId],
      ]);
    });
    test("purges expired and discarded content but preserves tombstones and live drafts", async () => {
      const expiredId = randomUUID(),
        discardedId = randomUUID(),
        liveId = randomUUID();
      for (const id of [expiredId, discardedId, liveId]) {
        await inTenant(() => saveInvoiceDraft(principal, id, input()));
      }
      await pool.query(
        "UPDATE invoice_drafts SET expires_at = now() - interval '1 day' WHERE firm_id = $1 AND id = $2",
        [firmId, expiredId],
      );
      await inTenant(() =>
        deleteInvoiceDraft(principal, clientId, discardedId, 1),
      );
      await sweepExpiredInvoiceDraftContent();
      const result = await pool.query(
        "SELECT id, content, revision, deleted_at FROM invoice_drafts WHERE firm_id = $1 AND id = ANY($2::uuid[])",
        [firmId, [expiredId, discardedId, liveId]],
      );
      assert.equal(result.rows.length, 3);
      for (const id of [expiredId, discardedId]) {
        const row = result.rows.find((r) => r.id === id)!;
        assert.deepEqual(row.content, {});
        assert.ok(row.deleted_at);
        assert.ok(row.revision > 0);
        await assert.rejects(
          inTenant(() => saveInvoiceDraft(principal, id, input())),
          /changed or was discarded/,
        );
      }
      assert.deepEqual(
        result.rows.find((r) => r.id === liveId)?.content,
        content(),
      );
      await assert.rejects(
        inTenant(async () => {
          await getDb().execute(
            sql`DELETE FROM invoice_drafts WHERE firm_id = ${firmId}::uuid`,
          );
        }),
        /permission denied/,
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
