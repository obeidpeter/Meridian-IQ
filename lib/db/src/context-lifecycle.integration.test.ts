import assert from "node:assert/strict";
import { test, after } from "node:test";
import { sql } from "drizzle-orm";
import {
  closeDatabasePools,
  requireDatabaseUrl,
  type Database,
} from "./client.ts";
import {
  finishHttpAuthentication,
  getDb,
  runHttpDatabaseBoundary,
  runRequestContext,
  withTransaction,
} from "./context.ts";
import { firmsTable } from "./schema/organizations.ts";

after(closeDatabasePools);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function expired(error: unknown): boolean {
  return (
    error instanceof Error &&
    (/Database context is no longer active/.test(error.message) ||
      expired(error.cause))
  );
}

test("PostgreSQL reuse: timed-out cached/prepared queries and nested cleanup cannot corrupt the next tenant transaction", async () => {
  requireDatabaseUrl();
  const firm = "11111111-1111-4111-8111-111111111111";
  for (const rejectChild of [false, true]) {
    const started = deferred();
    const resume = deferred();
    let nested!: Promise<void>;
    let old!: Database;
    let priorPid!: number;
    let executePrepared!: () => Promise<unknown>;
    let executeRaw!: () => Promise<unknown>;
    await runHttpDatabaseBoundary(async () => {
      finishHttpAuthentication();
      await assert.rejects(
        runRequestContext({ bypass: false, firmId: firm }, async () => {
          old = getDb();
          priorPid = (
            await old.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid() AS pid`,
            )
          ).rows[0].pid;
          const raw = old.execute(
            sql`SELECT set_config('app.firm_id', 'stale-tenant', true)`,
          );
          executeRaw = async () => raw;
          nested = withTransaction(async () => {
            const cached = getDb();
            const prepared = cached
              .select()
              .from(firmsTable)
              .prepare(`expired_${rejectChild}`);
            executePrepared = async () => prepared.execute();
            started.resolve();
            await resume.promise;
            await assert.rejects(
              cached.execute(
                sql`SELECT set_config('app.firm_id', 'stale-child', true)`,
              ),
              expired,
            );
            await assert.rejects(executePrepared(), expired);
            if (rejectChild) throw new Error("late child failed");
          });
          await started.promise;
          throw new Error("simulated HTTP timeout");
        }),
        /simulated HTTP timeout/,
      );
    });
    await runRequestContext({ bypass: false, firmId: firm }, async () => {
      const live = getDb();
      const pid = (
        await live.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)
      ).rows[0].pid;
      assert.equal(
        pid,
        priorPid,
        "this regression must exercise the very same physical connection",
      );
      await assert.rejects(
        old.execute(sql`SELECT set_config('app.firm_id', 'stale-root', true)`),
        expired,
      );
      await assert.rejects(executeRaw(), expired);
      resume.resolve();
      await assert.rejects(nested, rejectChild ? /late child failed/ : expired);
      // A late RELEASE/ROLLBACK TO on the old savepoint would abort this new
      // transaction; a stale query could replace its tenant GUC. Check both.
      const result = await live.execute<{ firm: string; value: number }>(
        sql`SELECT current_setting('app.firm_id') AS firm, 42 AS value`,
      );
      assert.deepEqual(result.rows[0], { firm, value: 42 });
    });
  }
});

test("PostgreSQL savepoint siblings cannot overlap or roll back another child's writes", async () => {
  requireDatabaseUrl();
  for (const bindAmbient of [false, true]) {
    for (const failChild of [false, true]) {
      await runRequestContext({ bypass: true, firmId: null }, async () => {
        const parent = getDb();
        await parent.execute(
          sql`CREATE TEMP TABLE scoped_sibling_writes (value text NOT NULL) ON COMMIT DROP`,
        );
        await parent.execute(
          sql`INSERT INTO scoped_sibling_writes VALUES ('parent')`,
        );
        const started = deferred();
        const resume = deferred();
        const open = (fn: (child: Database) => Promise<void>) =>
          bindAmbient
            ? withTransaction(() => fn(getDb()))
            : parent.transaction((tx) => fn(tx as unknown as Database));
        const first = open(async (child) => {
          await child.execute(
            sql`INSERT INTO scoped_sibling_writes VALUES ('first')`,
          );
          started.resolve();
          await resume.promise;
          if (failChild) throw new Error("first child failed");
        });
        const outcome = failChild
          ? assert.rejects(first, /first child failed/)
          : first;
        await started.promise;
        let rejectedBodyRan = false;
        try {
          await assert.rejects(
            open(async (child) => {
              rejectedBodyRan = true;
              await child.execute(
                sql`INSERT INTO scoped_sibling_writes VALUES ('forbidden sibling')`,
              );
            }),
            /Concurrent sibling transactions are not supported/,
          );
        } finally {
          resume.resolve();
          await outcome;
        }
        assert.equal(rejectedBodyRan, false);
        await open(async (child) => {
          await child.execute(
            sql`INSERT INTO scoped_sibling_writes VALUES ('second')`,
          );
        });
        const result = await parent.execute<{ value: string }>(
          sql`SELECT value FROM scoped_sibling_writes ORDER BY value`,
        );
        assert.deepEqual(
          result.rows.map((row) => row.value),
          failChild ? ["parent", "second"] : ["first", "parent", "second"],
        );
      });
    }
  }
});
