import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  asDatabaseConnectionError,
  DatabaseConnectionError,
  pool,
  workerLockPool,
} from "@workspace/db";
import { withDistributedLock } from "./distributed-lock.ts";
import {
  listSweeps,
  registerSweep,
  runSweepPassOnce,
  startWorker,
  stopWorker,
  resumeWorker,
  unregisterSweep,
} from "./pipeline.ts";

function lockClient() {
  const client = Object.assign(new EventEmitter(), {
    async query(text: string) {
      if (text.includes("pg_try_advisory_lock"))
        return { rows: [{ acquired: true }] };
      return { rows: [{ unlocked: true }] };
    },
    release() {},
  });
  return client;
}

function databaseClient() {
  return Object.assign(new EventEmitter(), {
    async query(config: string | { text: string }) {
      const text = typeof config === "string" ? config : config.text;
      if (text.includes("count(*) FILTER")) {
        return {
          rows: [
            {
              ready: 0,
              parked: 0,
              processing: 0,
              dead: 0,
              oldest_pending_age_seconds: 0,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0, fields: [] };
    },
    release() {},
  });
}

function runOwnershipLossChild(gracefulStarted: boolean): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}> {
  const script = `
    import { EventEmitter } from "node:events";
    import { writeSync } from "node:fs";
    import { pool, workerLockPool } from "@workspace/db";
    import {
      listSweeps, unregisterSweep, registerSweep, runSweepPassOnce,
      stopWorker, awaitWorkerIdle,
    } from "./src/modules/pipeline/pipeline.ts";
    import { installGracefulShutdown } from "./src/lib/shutdown.ts";
    const record = (event) => writeSync(1, "test:" + event + "\\n");
    pool.connect = async () => { throw new Error("Unexpected database access"); };
    const client = Object.assign(new EventEmitter(), {
      async query(text) {
        return { rows: [text.includes("pg_try_advisory_lock")
          ? { acquired: true } : { unlocked: true }] };
      },
      release() {},
    });
    workerLockPool.connect = async () => client;
    for (const sweep of listSweeps()) unregisterSweep(sweep.name);
    let release, started;
    const work = new Promise((resolve) => { release = resolve; });
    const ready = new Promise((resolve) => { started = resolve; });
    registerSweep("test.fatal-ownership", async (signal) => {
      signal.addEventListener("abort", () => record("abort-listener"));
      started();
      await work;
      record("stale-effect");
    }, { acceptsSignal: true, timeoutMs: 2_000 });
    installGracefulShutdown({
      server: { close(callback) { record("server-drain"); callback(); } },
      markUnready() { record("unready"); },
      stopWorker,
      awaitWorkerIdle: async (timeout) => {
        record("worker-drain");
        return awaitWorkerIdle(timeout);
      },
      closePool: async () => { record("pool-close"); },
      exit: (code) => { record("graceful-exit"); process.exit(code); },
      log: { info() {}, warn() {}, error() {} },
      timeoutMs: 2_000,
    });
    process.env.PIPELINE_HARD_STOP_ON_LOCK_LOSS = "0";
    const pass = runSweepPassOnce();
    await ready;
    if (${String(gracefulStarted)}) {
      process.emit("SIGTERM");
      await new Promise((resolve) => setImmediate(resolve));
    }
    record("ownership-lost");
    client.emit("error", new Error("Connection terminated unexpectedly"));
    record("returned-after-lock-loss");
    release();
    await pass;
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      env: { ...process.env, DATABASE_URL: "", PGOPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
      killSignal: "SIGKILL",
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
}

for (const gracefulStarted of [false, true]) {
  test(`ownership loss exits without stale continuations (graceful shutdown already started: ${gracefulStarted})`, async () => {
    const result = await runOwnershipLossChild(gracefulStarted);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.signal, null, result.output);
    const events = result.output
      .split(/\r?\n/)
      .filter((line) => line.startsWith("test:"));
    assert.ok(events.includes("test:ownership-lost"), result.output);
    assert.equal(events.at(-1), "test:ownership-lost", result.output);
    assert.ok(!events.includes("test:stale-effect"), result.output);
    if (gracefulStarted) {
      assert.ok(events.includes("test:worker-drain"), result.output);
    } else {
      assert.deepEqual(events, ["test:ownership-lost"]);
    }
  });
}

test("pool acquisition loss pauses without starting an unfenced task", async (t) => {
  const error = Object.assign(new Error("connection reset by peer"), {
    code: "ECONNRESET",
  });
  const lost: PromiseLike<unknown>[] = [];
  t.mock.method(workerLockPool, "connect", async () => {
    throw error;
  });

  await assert.rejects(
    withDistributedLock(
      991_102,
      async () => {
        throw new Error("task must not start");
      },
      (activeWork) => {
        if (activeWork) lost.push(activeWork);
      },
    ),
    (actual: unknown) => {
      assert.ok(actual instanceof Error);
      assert.equal(
        (actual as Error & { code?: string }).code,
        "DATABASE_CONNECTION_LOST",
      );
      assert.equal((actual as Error).cause, error);
      return true;
    },
  );
  assert.equal(lost.length, 0);
});

test("session loss passes the unsettled task fence to the stop policy", async (t) => {
  const client = lockClient();
  t.mock.method(workerLockPool, "connect", async () => client);
  let releaseTask!: () => void;
  const taskSettled = new Promise<void>((resolve) => {
    releaseTask = resolve;
  });
  let started!: () => void;
  const taskStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let activeWork: PromiseLike<unknown> | undefined;
  const operation = withDistributedLock(
    991_102,
    async () => {
      started();
      await taskSettled;
      return "completed";
    },
    (work) => {
      activeWork = work;
    },
  );

  await taskStarted;
  const error = new Error("server closed the connection unexpectedly");
  client.emit("error", error);
  assert.ok(activeWork, "loss policy must receive the running task fence");

  releaseTask();
  await assert.rejects(
    operation,
    (actual: unknown) =>
      actual instanceof DatabaseConnectionError && actual.cause === error,
  );
  await activeWork;
  assert.ok(
    asDatabaseConnectionError(error).cause === error,
    "the original disconnect remains available for diagnostics",
  );
});

test("an idle lock disconnect pauses, waits, and reconnects on a later pass", async (t) => {
  const previousBase = process.env.PIPELINE_DB_RETRY_BASE_MS;
  process.env.PIPELINE_DB_RETRY_BASE_MS = "5";
  let connects = 0;
  t.mock.method(pool, "connect", async () => databaseClient());
  t.mock.method(workerLockPool, "connect", async () => {
    connects += 1;
    if (connects === 1)
      throw Object.assign(new Error("connection reset by peer"), {
        code: "ECONNRESET",
      });
    return lockClient();
  });
  resumeWorker();
  try {
    assert.equal(await runSweepPassOnce(), false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await runSweepPassOnce(), true);
    assert.equal(connects, 2);
  } finally {
    stopWorker();
    if (previousBase === undefined)
      delete process.env.PIPELINE_DB_RETRY_BASE_MS;
    else process.env.PIPELINE_DB_RETRY_BASE_MS = previousBase;
  }
});

test("an unlock failure does not replay a completed compliance sweep", async (t) => {
  const name = `test.unlock-failure.${process.pid}`;
  const previousBase = process.env.PIPELINE_DB_RETRY_BASE_MS;
  process.env.PIPELINE_DB_RETRY_BASE_MS = "1";
  let effects = 0;
  let connections = 0;
  const client = lockClient();
  t.mock.method(client, "query", async (text: string) => {
    if (text.includes("pg_try_advisory_lock"))
      return { rows: [{ acquired: true }] };
    throw Object.assign(new Error("Connection terminated unexpectedly"), {
      code: "08006",
    });
  });
  t.mock.method(pool, "connect", async () => databaseClient());
  t.mock.method(workerLockPool, "connect", async () => {
    connections += 1;
    return client;
  });
  registerSweep(name, async () => {
    effects += 1;
  });
  resumeWorker();
  try {
    assert.equal(await runSweepPassOnce(), false);
    assert.equal(effects, 1);
    assert.equal(
      connections,
      1,
      "a release failure must wait for the next scheduled pass",
    );
  } finally {
    unregisterSweep(name);
    stopWorker();
    if (previousBase === undefined)
      delete process.env.PIPELINE_DB_RETRY_BASE_MS;
    else process.env.PIPELINE_DB_RETRY_BASE_MS = previousBase;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
});

test("pipeline exits immediately when a running pass loses its lock", async (t) => {
  for (const sweep of listSweeps()) unregisterSweep(sweep.name);
  const name = `test.lock-loss.${process.pid}`;
  const previousExitCode = process.exitCode;
  let releasePass!: () => void;
  const passReleased = new Promise<void>((resolve) => {
    releasePass = resolve;
  });
  let passStarted!: () => void;
  const passStartedPromise = new Promise<void>((resolve) => {
    passStarted = resolve;
  });
  let starts = 0;
  const client = lockClient();
  const exit = t.mock.method(process, "exit", () => undefined as never);
  const kill = t.mock.method(process, "kill", () => undefined as never);

  t.mock.method(pool, "connect", async () => databaseClient());
  t.mock.method(workerLockPool, "connect", async () => client);
  registerSweep(
    name,
    async () => {
      starts += 1;
      passStarted();
      await passReleased;
    },
    { acceptsSignal: true, timeoutMs: 1_000 },
  );
  resumeWorker();
  try {
    const pass = runSweepPassOnce();
    await passStartedPromise;
    client.emit("error", new Error("connection terminated"));
    assert.equal(exit.mock.callCount(), 1);
    assert.deepEqual(exit.mock.calls[0]?.arguments, [1]);
    assert.equal(
      kill.mock.callCount(),
      0,
      "fatal ownership loss must not enter SIGTERM draining",
    );
    startWorker(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 1, "no timer may overlap the unsettled stale task");
    releasePass();
    assert.equal(
      await pass,
      false,
      "the failed pass cannot report success after ownership loss",
    );

    // The old task has now settled, but its process is still fenced. Starting
    // timers again must not create a second pass; an operator/process restart
    // is required because this test intentionally ignores abort.
    startWorker(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 1);
  } finally {
    unregisterSweep(name);
    stopWorker();
    process.exitCode = previousExitCode;
  }
});
