import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryConfig } from "pg";
import { firmsTable } from "./schema/organizations.ts";
import { DatabaseConnectionError, isDatabaseConnectionError } from "./retry.ts";

process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { db, pool } = await import("./client.ts");
const {
  getDb,
  getSystemDb,
  runHttpDatabaseBoundary,
  finishHttpAuthentication,
  runRequestContext,
  runInBypassContext,
  hasDatabaseContext,
  withTransaction,
  runCorrelationContext,
  currentCorrelationId,
} = await import("./context.ts");

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

const siblingOverlap = /Concurrent sibling transactions are not supported/;

test("pool acquisition preserves permanent failures and classifies availability errors", async (t) => {
  for (const code of ["28P01", "3D000", "CERT_HAS_EXPIRED", "ECONNREFUSED"]) {
    const original = Object.assign(new Error("Acquisition refused"), { code });
    const connect = t.mock.method(pool, "connect", async () => {
      throw original;
    });
    let invoked = false;
    await assert.rejects(
      runInBypassContext(async () => {
        invoked = true;
      }),
      (error: unknown) => {
        if (code === "ECONNREFUSED") {
          assert.ok(error instanceof DatabaseConnectionError);
          assert.equal(error.cause, original);
          assert.equal(isDatabaseConnectionError(error), true);
        } else {
          assert.equal(error, original);
          assert.equal(isDatabaseConnectionError(error), false);
        }
        return true;
      },
    );
    assert.equal(invoked, false);
    connect.mock.restore();
  }
});

// Only the wire transport is fake: all sessions, lazy builders, relational
// queries, prepared execution and savepoint orchestration are the real code.
class ReusedClient extends EventEmitter {
  lease = 0;
  released = true;
  releases: boolean[] = [];
  calls: Array<{ text: string; values: unknown[]; lease: number }> = [];
  tail: Promise<unknown> = Promise.resolve();
  beforeQuery: (text: string) => Promise<void> = async () => {};
  dispatched: (text: string) => void = () => {};

  checkout(): PoolClient {
    assert.equal(
      this.released,
      true,
      "a leased physical client cannot be borrowed again",
    );
    this.released = false;
    this.lease += 1;
    return this as unknown as PoolClient;
  }

  query(config: string | QueryConfig, values: unknown[] = []) {
    assert.equal(
      this.released,
      false,
      "SQL reached a returned physical client",
    );
    const text = typeof config === "string" ? config : config.text;
    this.calls.push({ text, values, lease: this.lease });
    this.dispatched(text);
    // Like node-postgres, execute queued commands in order on this connection.
    const result = this.tail.then(async () => {
      await this.beforeQuery(text);
      return { rows: [], rowCount: 0, fields: [], command: text.split(" ")[0] };
    });
    this.tail = result.catch(() => {});
    return result;
  }

  release(destroy = false) {
    assert.equal(this.released, false);
    this.released = true;
    this.releases.push(destroy);
  }
}

function transport(t: TestContext) {
  const client = new ReusedClient();
  t.mock.method(pool, "connect", async () => client.checkout());
  return client;
}

test("HTTP getDb fails closed before and after auth; system access closes before handlers", async () => {
  assert.equal(getDb(), db, "non-HTTP fallback is transitional");
  await runHttpDatabaseBoundary(async () => {
    assert.throws(getDb, /explicit database context/);
    assert.equal(getSystemDb("authentication"), db);
    await Promise.resolve();
    finishHttpAuthentication();
    assert.throws(getDb, /explicit database context/);
    assert.throws(() => getSystemDb("authentication"), /forbidden/);
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
    assert.throws(
      getDb,
      /explicit database context/,
      "async descendants cannot fall back",
    );
  });
  assert.equal(getDb(), db);
});

test("explicit scopes set RLS, preserve nested ambient transactions and reject stale descendants", async (t) => {
  const client = transport(t);
  const resume = deferred();
  let pending!: Promise<void>;
  await runHttpDatabaseBoundary(async () => {
    finishHttpAuthentication();
    await runCorrelationContext("request-test", () =>
      runRequestContext(
        { bypass: false, firmId: "11111111-1111-4111-8111-111111111111" },
        async () => {
          const parent = getDb();
          assert.equal(currentCorrelationId(), "request-test");
          assert.equal(getSystemDb("authentication"), parent);
          assert.equal(hasDatabaseContext(), true);
          await withTransaction(async () => {
            assert.notEqual(getDb(), parent);
            await getDb().execute(sql`select 'child'`);
          });
          assert.equal(getDb(), parent);
          await assert.rejects(
            withTransaction(async () => {
              await getDb().execute(sql`select 'rolled back child'`);
              throw new Error("child refusal");
            }),
            /child refusal/,
          );
          await getDb().execute(sql`select 'parent still valid'`);
          pending = resume.promise.then(async () => {
            assert.throws(getDb, expired);
            assert.throws(() => getSystemDb("authentication"), expired);
            await assert.rejects(
              runInBypassContext(async () => undefined),
              expired,
            );
          });
        },
      ),
    );
    assert.throws(getDb, /explicit database context/);
    resume.resolve();
    await pending;
  });
  assert.deepEqual(
    client.calls.slice(0, 5).map((call) => call.text),
    [
      "BEGIN",
      "SET LOCAL ROLE meridian_app",
      "SELECT set_config('app.bypass', $1, true)",
      "SELECT set_config('app.firm_id', $1, true)",
      "SELECT set_config('app.correlation_id', $1, true)",
    ],
  );
  assert.deepEqual(client.calls[2].values, ["off"]);
  assert.deepEqual(client.calls[4].values, ["request-test"]);
  assert.ok(client.calls.some((call) => call.text === "release savepoint sp1"));
  assert.ok(
    client.calls.some((call) => call.text === "rollback to savepoint sp1"),
  );
  assert.equal(client.calls.at(-1)?.text, "COMMIT");
  assert.deepEqual(client.releases, [false]);
});

test("concurrent HTTP authentication phases do not leak", async () => {
  const gate = deferred();
  const early = runHttpDatabaseBoundary(async () => {
    await gate.promise;
    assert.equal(getSystemDb("authentication"), db);
    assert.throws(getDb, /explicit database context/);
  });
  await runHttpDatabaseBoundary(async () => {
    finishHttpAuthentication();
    assert.throws(() => getSystemDb("authentication"), /forbidden/);
    gate.resolve();
    await early;
    assert.throws(() => getSystemDb("authentication"), /forbidden/);
  });
});

test("cached handles and prebuilt raw, select, prepared and relational queries are revoked before reuse", async (t) => {
  const client = transport(t);
  for (const abort of [false, true]) {
    const executions: Array<() => Promise<unknown>> = [];
    const original = runInBypassContext(async () => {
      const cached = getDb();
      const lazy = cached.select().from(firmsTable);
      const prepared = lazy.prepare(`expired_${client.lease}`);
      const raw = cached.execute(sql`select 'prebuilt raw'`);
      const relational = cached.query.firmsTable.findMany();
      executions.push(
        async () => cached.execute(sql`select 'cached handle'`),
        async () => lazy,
        async () => raw,
        async () => prepared.execute(),
        async () => relational,
        async () => cached.select().from(firmsTable),
        async () =>
          cached.transaction(async (tx) =>
            tx.execute(sql`select 'stale transaction'`),
          ),
      );
      if (abort) throw new Error("HTTP deadline expired");
    });
    if (abort) await assert.rejects(original, /HTTP deadline expired/);
    else await original;
    await runInBypassContext(async () => {
      const before = client.calls.length;
      for (const execute of executions)
        await assert.rejects(execute(), expired);
      assert.equal(
        client.calls.length,
        before,
        "no stale SQL reached the new borrower",
      );
      await getDb().execute(sql`select 'new borrower remains usable'`);
    });
  }
  assert.deepEqual(client.releases, [false, false, false, false]);
});

test("completed child's cached and prepared handles are revoked while its parent remains live", async (t) => {
  const client = transport(t);
  for (const bindAmbient of [false, true]) {
    await runInBypassContext(async () => {
      let execute!: () => Promise<unknown>;
      let preparedExecute!: () => Promise<unknown>;
      const body = async (child: typeof db) => {
        const prepared = child
          .select()
          .from(firmsTable)
          .prepare(`child_${bindAmbient}`);
        execute = async () => child.execute(sql`select 'expired child'`);
        preparedExecute = async () => prepared.execute();
      };
      if (bindAmbient) await withTransaction(() => body(getDb()));
      else await getDb().transaction((tx) => body(tx as unknown as typeof db));
      const before = client.calls.length;
      await assert.rejects(execute(), expired);
      await assert.rejects(preparedExecute(), expired);
      assert.equal(client.calls.length, before);
      await getDb().execute(sql`select 'live parent'`);
    });
  }
});

test("suspended nested success/failure cannot dispatch cached SQL or savepoint cleanup on a reused connection", async (t) => {
  const client = transport(t);
  for (const rejectChild of [false, true]) {
    for (const bindAmbient of [false, true]) {
      const resume = deferred();
      const started = deferred();
      let nested!: Promise<unknown>;
      await runHttpDatabaseBoundary(async () => {
        finishHttpAuthentication();
        await assert.rejects(
          runInBypassContext(async () => {
            const body = async (child: typeof db) => {
              const cached = child;
              const prepared = cached
                .select()
                .from(firmsTable)
                .prepare(`nested_${client.lease}`);
              started.resolve();
              await resume.promise;
              assert.throws(getDb, expired);
              await assert.rejects(
                cached.execute(sql`select 'late child'`),
                expired,
              );
              await assert.rejects(prepared.execute(), expired);
              if (rejectChild) throw new Error("late child refusal");
            };
            nested = bindAmbient
              ? withTransaction(() => body(getDb()))
              : getDb().transaction((tx) => body(tx as unknown as typeof db));
            await started.promise;
            throw new Error("outer HTTP deadline expired");
          }),
          /outer HTTP deadline expired/,
        );
      });
      assert.equal(client.released, true);
      await runInBypassContext(async () => {
        const before = client.calls.length;
        resume.resolve();
        await assert.rejects(
          nested,
          rejectChild ? /late child refusal/ : expired,
        );
        assert.equal(
          client.calls.length,
          before,
          "neither RELEASE nor ROLLBACK TO reached the new lease",
        );
        await getDb().execute(sql`select 'unrelated request'`);
      });
    }
  }
});

test("suspended grandchild cannot use a completed middle scope while the root remains live", async (t) => {
  const client = transport(t);
  await runInBypassContext(async () => {
    const started = deferred();
    const resume = deferred();
    let grandchild!: Promise<void>;
    await withTransaction(async () => {
      grandchild = withTransaction(async () => {
        const cached = getDb();
        const lazy = cached.execute(sql`select 'expired grandchild'`);
        started.resolve();
        await resume.promise;
        assert.throws(getDb, expired);
        await assert.rejects(lazy, expired);
        await assert.rejects(
          cached.execute(sql`select 'late grandchild'`),
          expired,
        );
      });
      await started.promise;
    });
    const before = client.calls.length;
    resume.resolve();
    await assert.rejects(grandchild, expired);
    assert.equal(
      client.calls.length,
      before,
      "grandchild SQL and cleanup cannot reach the live root",
    );
    await getDb().execute(sql`select 'root remains live'`);
  });
});

test("timeout revokes new dispatch immediately and holds the client until already-issued SQL and rollback drain", async (t) => {
  const client = transport(t);
  const blocked = deferred();
  const started = deferred();
  const rollingBack = deferred();
  client.beforeQuery = async (text) => {
    if (text.includes("already issued")) {
      started.resolve();
      await blocked.promise;
    }
  };
  client.dispatched = (text) => {
    if (text === "ROLLBACK") rollingBack.resolve();
  };
  let cached!: typeof db;
  let issued!: Promise<unknown>;
  const request = runInBypassContext(async () => {
    cached = getDb();
    issued = cached
      .execute(sql`select 'already issued'`)
      .then((result) => result);
    await started.promise;
    throw new Error("request timed out");
  });
  const rejection = assert.rejects(request, /request timed out/);
  await rollingBack.promise;
  assert.equal(
    client.released,
    false,
    "rollback is queued behind the active statement",
  );
  assert.deepEqual(client.releases, []);
  const before = client.calls.length;
  await assert.rejects(cached.execute(sql`select 'too late'`), expired);
  assert.equal(client.calls.length, before);
  blocked.resolve();
  await issued;
  await rejection;
  assert.deepEqual(client.releases, [false]);
  assert.equal(client.calls.at(-1)?.text, "ROLLBACK");
});

test("sibling admission is rejected before SQL during savepoint creation, callback and cleanup", async (t) => {
  const client = transport(t);
  for (const bindAmbient of [false, true]) {
    for (const failChild of [false, true]) {
      await runInBypassContext(async () => {
        const opening = deferred();
        const allowOpen = deferred();
        const bodyStarted = deferred();
        const allowBody = deferred();
        const cleanupStarted = deferred();
        const allowCleanup = deferred();
        client.beforeQuery = async (text) => {
          if (text === "savepoint sp1") {
            opening.resolve();
            await allowOpen.promise;
          }
          if (
            text === "release savepoint sp1" ||
            text === "rollback to savepoint sp1"
          ) {
            cleanupStarted.resolve();
            await allowCleanup.promise;
          }
        };
        const parent = getDb();
        const open = (fn: (child: typeof db) => Promise<void>) =>
          bindAmbient
            ? withTransaction(() => fn(getDb()))
            : parent.transaction((tx) => fn(tx as unknown as typeof db));
        let rejectedCallbacks = 0;
        const forbiddenBody = async () => {
          rejectedCallbacks += 1;
        };
        const first = open(async (child) => {
          await child.execute(sql`select 'first child write'`);
          bodyStarted.resolve();
          await allowBody.promise;
          if (failChild) throw new Error("first child failed");
        });
        const outcome = failChild
          ? assert.rejects(first, /first child failed/)
          : first;
        // Both calls happen in one tick, before SAVEPOINT's first await resumes.
        await assert.rejects(open(forbiddenBody), siblingOverlap);
        await opening.promise;
        const rejectBothEntryPoints = async () => {
          const before = client.calls.length;
          await assert.rejects(
            parent.transaction(forbiddenBody),
            siblingOverlap,
          );
          await assert.rejects(withTransaction(forbiddenBody), siblingOverlap);
          assert.equal(
            client.calls.length,
            before,
            "a rejected sibling must send no SQL",
          );
        };
        await rejectBothEntryPoints();
        allowOpen.resolve();
        await bodyStarted.promise;
        await rejectBothEntryPoints();
        allowBody.resolve();
        await cleanupStarted.promise;
        await rejectBothEntryPoints();
        allowCleanup.resolve();
        await outcome;
        assert.equal(rejectedCallbacks, 0);
        await open(async (child) => {
          await child.execute(sql`select 'subsequent child write'`);
        });
      });
    }
  }
});

test("failed savepoint creation frees sibling admission and true nested children remain supported", async (t) => {
  const client = transport(t);
  await runInBypassContext(async () => {
    const failure = new Error("savepoint creation failed");
    client.beforeQuery = async (text) => {
      if (text === "savepoint sp1") throw failure;
    };
    await assert.rejects(
      withTransaction(async () => undefined),
      (error: unknown) => error instanceof Error && error.cause === failure,
    );
    assert.equal(
      client.calls.some((call) => call.text.startsWith("rollback to")),
      false,
    );
    client.beforeQuery = async () => {};
    await withTransaction(async () => {
      await withTransaction(async () => {
        await getDb().execute(sql`select 'nested ambient'`);
      });
      await getDb().transaction(async (child) => {
        await child.transaction(async (grandchild) => {
          await grandchild.execute(sql`select 'nested explicit'`);
        });
      });
    });
    assert.ok(client.calls.some((call) => call.text === "savepoint sp3"));
  });
});

test("failed BEGIN, failed rollback, and connection errors destroy rather than recycle the client", async (t) => {
  const client = transport(t);
  client.beforeQuery = async (text) => {
    if (text === "BEGIN") throw new Error("begin failed");
  };
  await assert.rejects(
    runInBypassContext(async () => undefined),
    /begin failed/,
  );
  client.beforeQuery = async (text) => {
    if (text === "ROLLBACK") throw new Error("rollback failed");
  };
  await assert.rejects(
    runInBypassContext(async () => {
      throw new Error("body failed");
    }),
    /body failed/,
  );
  client.beforeQuery = async () => {};
  const disconnect = Object.assign(new Error("connection failed"), {
    code: "08006",
  });
  await assert.rejects(
    runInBypassContext(async () => {
      client.emit("error", disconnect);
      await getDb().execute(sql`select 'forbidden after connection error'`);
    }),
    (error: unknown) => {
      assert.ok(error instanceof DatabaseConnectionError);
      assert.equal(error.cause, disconnect);
      assert.equal(isDatabaseConnectionError(error), true);
      return true;
    },
  );
  assert.deepEqual(client.releases, [true, true, true]);
  assert.equal(client.listenerCount("error"), 0);
});
