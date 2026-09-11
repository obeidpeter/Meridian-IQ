import { test } from "node:test";
import assert from "node:assert/strict";
import { pool, workerLockPool } from "@workspace/db";
import {
  listSweeps,
  unregisterSweep,
  registerSweep,
  runSweepPassOnce,
  awaitWorkerIdle,
  resumeWorker,
} from "./pipeline.ts";

test("a timed-out scheduled sweep keeps its distributed lock until underlying settlement", async () => {
  // This file has its own worker registry. Run only the barrier-controlled work.
  for (const sweep of listSweeps()) unregisterSweep(sweep.name);
  resumeWorker();
  let finish!: () => void;
  const work = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let calls = 0;
  let legacyDependency: { flag?: boolean } | undefined;
  let cancellation: AbortSignal | undefined;
  registerSweep(
    "test.distributed-ownership",
    async (deps?: { flag?: boolean }) => {
      legacyDependency = deps;
      calls += 1;
      await work;
    },
    { timeoutMs: 20 },
  );
  registerSweep(
    "test.cancellable",
    async (signal) => {
      cancellation = signal;
    },
    { acceptsSignal: true },
  );
  const competing = await pool.connect();
  try {
    assert.equal(
      await runSweepPassOnce(),
      true,
      "timeout returns control to the caller",
    );
    assert.equal(calls, 1);
    assert.equal(
      legacyDependency,
      undefined,
      "an AbortSignal is not passed as legacy dependencies",
    );
    assert.ok(
      cancellation instanceof AbortSignal,
      "explicit signal opt-in is honoured",
    );
    assert.equal(
      await runSweepPassOnce(),
      false,
      "a later local tick cannot overlap",
    );
    assert.equal(
      workerLockPool.totalCount - workerLockPool.idleCount,
      1,
      "only the dedicated lock pool retains a session",
    );
    assert.equal(
      (await competing.query("SELECT pg_try_advisory_lock(991102) AS acquired"))
        .rows[0].acquired,
      false,
      "another process cannot acquire the timed-out pass lock",
    );
    assert.equal(await awaitWorkerIdle(5), false);
    finish();
    assert.equal(await awaitWorkerIdle(1_000), true);
    assert.equal(
      (await competing.query("SELECT pg_try_advisory_lock(991102) AS acquired"))
        .rows[0].acquired,
      true,
    );
    await competing.query("SELECT pg_advisory_unlock(991102)");
    assert.equal(workerLockPool.totalCount - workerLockPool.idleCount, 0);
  } finally {
    finish();
    await awaitWorkerIdle(1_000);
    unregisterSweep("test.distributed-ownership");
    unregisterSweep("test.cancellable");
    competing.release(true);
  }
});

test("a lost lock session requests immediate exit before cooperative cleanup", async (t) => {
  for (const sweep of listSweeps()) unregisterSweep(sweep.name);
  resumeWorker();
  const previousExitCode = process.exitCode;
  const kill = t.mock.method(process, "kill", () => undefined as never);
  let calls = 0;
  let aborted = false;
  const exit = t.mock.method(process, "exit", () => {
    assert.equal(aborted, false, "termination must precede abort listeners");
    return undefined as never;
  });
  let started!: () => void;
  let releaseSettlement!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const settlement = new Promise<void>((resolve) => {
    releaseSettlement = resolve;
  });
  registerSweep(
    "test.lock-loss-recovery",
    async (signal) => {
      calls += 1;
      if (calls > 1) return;
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      await settlement;
    },
    { acceptsSignal: true, timeoutMs: 2_000 },
  );

  const admin = await pool.connect();
  try {
    const pass = runSweepPassOnce();
    await firstStarted;
    const sessions = await admin.query<{ pid: number }>(
      `SELECT pid
       FROM pg_stat_activity
       WHERE application_name = 'meridian-worker-locks'
       ORDER BY backend_start DESC
       LIMIT 1`,
    );
    assert.ok(sessions.rows[0]?.pid, "the pass owns a worker-lock session");
    assert.equal(
      (
        await admin.query<{ terminated: boolean }>(
          "SELECT pg_terminate_backend($1) AS terminated",
          [sessions.rows[0]!.pid],
        )
      ).rows[0]?.terminated,
      true,
    );
    for (let i = 0; i < 50 && !aborted; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(aborted, true, "cleanup runs only because the exit is mocked");
    assert.equal(exit.mock.callCount(), 1);
    assert.deepEqual(exit.mock.calls[0]?.arguments, [1]);
    assert.equal(
      kill.mock.callCount(),
      0,
      "ownership loss must not request graceful draining",
    );
    assert.equal(
      await runSweepPassOnce(),
      false,
      "no local pass or retry overlaps unsettled aborted work",
    );
    releaseSettlement();
    assert.equal(
      await pass,
      false,
      "the failed pass does not report success after lock loss",
    );
    assert.equal(await awaitWorkerIdle(2_000), true);
    assert.equal(calls, 1, "a replacement pass requires a new process");
  } finally {
    releaseSettlement();
    unregisterSweep("test.lock-loss-recovery");
    admin.release();
    process.exitCode = previousExitCode;
  }
});
