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
