import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  asDatabaseConnectionError,
  DatabaseConnectionError,
  pool,
  workerLockPool,
} from "@workspace/db";
import { withDistributedLock } from "./distributed-lock.ts";
import {
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

test("pipeline requires restart when a running pass loses its lock", async (t) => {
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
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(kill.mock.calls[0]?.arguments, [process.pid, "SIGTERM"]);
    startWorker(5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(starts, 1, "no timer may overlap the unsettled stale task");
    releasePass();
    assert.equal(
      await pass,
      true,
      "the pass acquired the lock even though it later lost ownership",
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
