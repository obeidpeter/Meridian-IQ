import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import {
  closeDatabasePools,
  getDb,
  getSystemDb,
  pool,
  workerLockPool,
  withTransaction,
  type Database,
} from "@workspace/db";
import { listen, closeAllServers } from "./test-helpers/route-harness.ts";
import { errorHandler } from "./middleware/error.ts";
import { NO_CONTEXT_PATHS } from "./middleware/request-policy.ts";

const _connectClient = () => pool.connect();
type PoolClient = Awaited<ReturnType<typeof _connectClient>>;

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

test("main request middleware: commit-before-response, missing scopes, timeout, disconnect and cached child cleanup", async (t) => {
  const environment = {
    NODE_ENV: "test",
    ENABLE_DEV_AUTH: "true",
    RATE_LIMIT_GENERAL_PER_MIN: "0",
    RATE_LIMIT_MODEL_PER_MIN: "0",
    CLERK_SECRET_KEY: undefined,
  };
  const previous = new Map(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const commitStarted = deferred();
  const allowCommit = deferred();
  const disconnected = deferred();
  const childStarted = deferred();
  const resumeChild = deferred();
  const timeoutStarted = deferred();
  const calls: string[] = [];
  let leased = false;
  let holdCommit = true;
  let releases = 0;
  let child!: Promise<void>;
  let cached!: Database;
  let lazy!: PromiseLike<unknown>;
  let timeoutHandle!: Database;
  let timeoutSignal!: AbortSignal;
  const client = Object.assign(new EventEmitter(), {
    query: async (config: string | { text: string }) => {
      assert.equal(leased, true, "no SQL may reach a released physical client");
      const text = typeof config === "string" ? config : config.text;
      calls.push(text);
      if (text === "COMMIT" && holdCommit) {
        commitStarted.resolve();
        await allowCommit.promise;
      }
      return { rows: [], rowCount: 0, fields: [] };
    },
    release: (destroy: boolean) => {
      assert.equal(leased, true);
      assert.equal(destroy, false);
      leased = false;
      releases += 1;
      if (calls.at(-1) === "ROLLBACK") disconnected.resolve();
    },
  });
  t.mock.method(pool, "connect", async () => {
    assert.equal(leased, false);
    leased = true;
    return client as unknown as PoolClient;
  });
  // Never reach a configured database, even when this pure test runs in DB CI.
  t.mock.method(pool, "query", () =>
    assert.fail("unexpected raw database query"),
  );
  t.mock.method(workerLockPool, "connect", () =>
    assert.fail("unexpected worker connection"),
  );
  t.mock.method(workerLockPool, "query", () =>
    assert.fail("unexpected worker query"),
  );
  const missingPath = "/api/_context-fixture/missing";
  NO_CONTEXT_PATHS.add(missingPath);
  try {
    const { default: app } = await import("./app.ts");
    app.get("/api/_context-fixture/success", async (_req, res) => {
      const root = getDb();
      await withTransaction(async () => {
        await getDb().execute(sql`SELECT 'child write'`);
      });
      assert.equal(getDb(), root);
      res.json({ ok: true });
    });
    app.get(missingPath, (_req, _res) => {
      assert.throws(() => getSystemDb("authentication"), /forbidden/);
      getDb();
    });
    app.get("/api/_context-fixture/disconnect", (_req, _res) => {
      cached = getDb();
      lazy = cached.execute(sql`SELECT 'cached root'`);
      child = withTransaction(async () => {
        const handle = getDb();
        const prebuilt = handle.execute(sql`SELECT 'cached child'`);
        childStarted.resolve();
        await resumeChild.promise;
        await assert.rejects(prebuilt, expired);
      });
      // This intentionally detached callback outlives the closed HTTP response.
      void child.catch(() => {});
    });
    app.get("/api/_context-fixture/reuse", async (_req, res) => {
      const before = calls.length;
      await assert.rejects(cached.execute(sql`SELECT 'late root'`), expired);
      await assert.rejects(async () => lazy, expired);
      resumeChild.resolve();
      await assert.rejects(child, expired);
      assert.equal(
        calls.length,
        before,
        "stale SQL and savepoint cleanup must not dispatch",
      );
      await getDb().execute(sql`SELECT 'new request'`);
      res.json({ reused: true });
    });
    app.get("/api/_context-fixture/timeout", (req, _res) => {
      timeoutHandle = getDb();
      timeoutSignal = req.abortSignal;
      timeoutStarted.resolve();
    });
    app.use(errorHandler);
    const base = await listen(app);
    const headers = {
      "x-mock-role": "firm_admin",
      "x-mock-user": "11111111-1111-4111-8111-111111111111",
      "x-mock-firm": "22222222-2222-4222-8222-222222222222",
    };
    let responseReceived = false;
    const success = fetch(base + "/api/_context-fixture/success", {
      headers,
    }).then((response) => {
      responseReceived = true;
      return response;
    });
    await commitStarted.promise;
    assert.equal(responseReceived, false);
    assert.equal(leased, true);
    allowCommit.resolve();
    const committed = await success;
    assert.equal(committed.status, 200);
    assert.deepEqual(await committed.json(), { ok: true });
    assert.equal(leased, false);
    holdCommit = false;
    const beforeMissing = calls.length;
    const missing = await fetch(base + missingPath, { headers });
    assert.equal(missing.status, 500);
    await missing.text();
    assert.equal(
      calls.length,
      beforeMissing,
      "exemption must not acquire a raw or managed connection",
    );
    const abort = new AbortController();
    const abandoned = fetch(base + "/api/_context-fixture/disconnect", {
      headers,
      signal: abort.signal,
    });
    const aborted = assert.rejects(
      abandoned,
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
    await childStarted.promise;
    abort.abort();
    await aborted;
    await disconnected.promise;
    const reused = await fetch(base + "/api/_context-fixture/reuse", {
      headers,
    });
    assert.equal(reused.status, 200);
    assert.deepEqual(await reused.json(), { reused: true });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timeoutResponse = fetch(base + "/api/_context-fixture/timeout", {
      headers,
    });
    await timeoutStarted.promise;
    t.mock.timers.tick(30_001);
    const timedOut = await timeoutResponse;
    assert.equal(timedOut.status, 503);
    assert.deepEqual(await timedOut.json(), { error: "Request timed out" });
    assert.equal(timeoutSignal.aborted, true);
    await assert.rejects(
      timeoutHandle.execute(sql`SELECT 'after timeout'`),
      expired,
    );
    t.mock.timers.reset();
    assert.equal(releases, 4);
    assert.equal(client.listenerCount("error"), 0);
  } finally {
    t.mock.timers.reset();
    allowCommit.resolve();
    resumeChild.resolve();
    NO_CONTEXT_PATHS.delete(missingPath);
    await closeAllServers();
    await closeDatabasePools();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
