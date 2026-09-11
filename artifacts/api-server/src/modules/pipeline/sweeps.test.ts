import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseConnectionError } from "@workspace/db";
import {
  registerSweep,
  unregisterSweep,
  listSweeps,
  orderedSweeps,
  runSweepsOnce,
  SweepTimeoutError,
  type RegisteredSweep,
} from "./sweeps.ts";
import { awaitWorkerIdle, inFlightPasses } from "./in-flight.ts";
import { stopWorker, resumeWorker } from "./pipeline.ts";
import { registry } from "../../lib/metrics.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { atMostHourly } from "../clerk/watch-shared.ts";

// Sweep hygiene (R101): every sweep is named, runs under a timeout, and
// reports under its own label. runSweepsOnce is driven over an explicit list
// so the registry (and the 40 real sweeps) stay untouched.

const SALT = makeRunSalt().toLowerCase();
const registered: string[] = [];

after(() => {
  for (const name of registered) unregisterSweep(name);
});

test("registration needs a well-formed, unique name; unregister removes it", () => {
  const name = `test.sweep_${SALT}`;
  registerSweep(name, async () => {});
  registered.push(name);
  assert.ok(listSweeps().some((s) => s.name === name && s.timeoutMs > 0));
  assert.throws(
    () => registerSweep(name, async () => {}),
    /already registered/,
  );
  assert.throws(() => registerSweep("Bad Name!", async () => {}), /must match/);
  assert.equal(unregisterSweep(name), true);
  assert.equal(unregisterSweep(name), false);
  registered.pop();
});

test("a throwing sweep and a hung sweep are counted under their names and kinds; a good sweep records its last success", async () => {
  const good = `test.good_${SALT}`;
  const bad = `test.bad_${SALT}`;
  const slow = `test.slow_${SALT}`;
  let settleSlow!: () => void;
  const slowWork = new Promise<void>((resolve) => {
    settleSlow = resolve;
  });
  const sweeps: RegisteredSweep[] = [
    { name: good, run: async () => {}, timeoutMs: 1_000 },
    {
      name: bad,
      run: async () => {
        throw new Error("boom");
      },
      timeoutMs: 1_000,
    },
    { name: slow, run: () => slowWork, timeoutMs: 30 },
  ];
  const failures = await runSweepsOnce(sweeps);
  assert.equal(failures, 2, "the good sweep passed; the other two failed");
  const text = await registry.metrics();
  assert.match(
    text,
    new RegExp(
      `meridian_sweep_errors_total\\{sweep="${bad}",kind="error"\\} 1`,
    ),
  );
  assert.match(
    text,
    new RegExp(
      `meridian_sweep_errors_total\\{sweep="${slow}",kind="timeout"\\} 1`,
    ),
  );
  assert.match(
    text,
    new RegExp(
      `meridian_sweep_last_success_by_sweep_timestamp_seconds\\{sweep="${good}"\\} \\d`,
    ),
  );
  assert.doesNotMatch(
    text,
    new RegExp(
      `meridian_sweep_last_success_by_sweep_timestamp_seconds\\{sweep="${bad}"\\}`,
    ),
    "a failed sweep never reads as succeeded",
  );
  assert.match(
    text,
    new RegExp(
      `meridian_sweep_duration_seconds_count\\{sweep="${slow}",outcome="timeout"\\} 1`,
    ),
  );
  assert.ok(new SweepTimeoutError("x", 1).message.includes("exceeded"));
  assert.equal(
    await awaitWorkerIdle(5),
    false,
    "the timeout did not abandon underlying work",
  );
  settleSlow();
  assert.equal(await awaitWorkerIdle(100), true);
});

test("a database disconnect is surfaced without replaying effects before later registry entries", async () => {
  let reachedAfterDisconnect = false;
  let externalEffects = 0;
  const report = { failed: [], critical: 0 } as {
    failed: string[];
    critical: number;
    databaseFailure?: unknown;
  };
  const failures = await runSweepsOnce(
    [
      {
        name: `test.db-disconnect.${SALT}`,
        run: async () => {
          externalEffects += 1;
          throw new DatabaseConnectionError(
            new Error("server closed the connection unexpectedly"),
          );
        },
        timeoutMs: 1_000,
      },
      {
        name: `test.after-db-disconnect.${SALT}`,
        run: async () => {
          reachedAfterDisconnect = true;
        },
        timeoutMs: 1_000,
      },
    ],
    [],
    report,
  );
  assert.equal(failures, 1);
  assert.equal(
    externalEffects,
    1,
    "a failed sweep must not replay its effects",
  );
  assert.equal(reachedAfterDisconnect, true);
  assert.ok(report.databaseFailure instanceof DatabaseConnectionError);
});

test("timeout keeps per-sweep ownership until late rejection while healthy siblings continue", async () => {
  let reject!: (error: Error) => void;
  let signal!: AbortSignal;
  let calls = 0;
  let healthy = 0;
  const work = new Promise<void>((_, fail) => {
    reject = fail;
  });
  const sweep: RegisteredSweep = {
    name: `test.owned_${SALT}`,
    timeoutMs: 10,
    run: (abort) => {
      signal = abort;
      calls += 1;
      return work;
    },
  };
  try {
    assert.equal(await runSweepsOnce([sweep]), 1);
    assert.equal(signal.aborted, true);
    assert.equal(
      await runSweepsOnce([
        sweep,
        {
          name: `test.sibling_${SALT}`,
          timeoutMs: 100,
          run: async () => {
            healthy += 1;
          },
        },
      ]),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(healthy, 1);
    assert.equal(await awaitWorkerIdle(5), false);
  } finally {
    reject(new Error("late rejection"));
  }
  assert.equal(await awaitWorkerIdle(100), true);
  assert.equal(
    await runSweepsOnce([
      {
        ...sweep,
        run: async () => {
          calls += 1;
        },
      },
    ]),
    0,
  );
  assert.equal(calls, 2);
});

test("a later scheduled pass can recover without retrying the failed sweep in place", async () => {
  const name = `test.database_next_pass_${SALT}`;
  let calls = 0;
  const sweep: RegisteredSweep = {
    name,
    timeoutMs: 1_000,
    run: async () => {
      calls += 1;
      if (calls === 1) throw { code: "08006" };
    },
  };
  assert.equal(await runSweepsOnce([sweep]), 1);
  assert.equal(calls, 1);
  assert.doesNotMatch(
    await registry.metrics(),
    new RegExp(
      `valo_sweep_last_success_by_sweep_timestamp_seconds\\{sweep="${name}"\\}`,
    ),
  );
  assert.equal(await runSweepsOnce([sweep]), 0);
  assert.equal(calls, 2);
  assert.match(
    await registry.metrics(),
    new RegExp(
      `valo_sweep_last_success_by_sweep_timestamp_seconds\\{sweep="${name}"\\} \\d`,
    ),
  );
});

test("persistent database failure is counted after one attempt", async () => {
  const name = `test.database_failed_${SALT}`;
  let calls = 0;
  assert.equal(
    await runSweepsOnce([
      {
        name,
        timeoutMs: 1_000,
        run: async () => {
          calls += 1;
          throw { code: "57P03" };
        },
      },
    ]),
    1,
  );
  assert.equal(calls, 1);
  assert.match(
    await registry.metrics(),
    new RegExp(`valo_sweep_errors_total\\{sweep="${name}",kind="error"\\} 1`),
  );
});

test("an hourly cadence gate cannot turn a failed sweep into a successful recovery", async () => {
  const name = `test.hourly_failure_${SALT}`;
  const error = new DatabaseConnectionError(new Error("connection terminated"));
  let calls = 0;
  const run = atMostHourly(async () => {
    calls += 1;
    throw error;
  });
  const report = {
    failed: [] as string[],
    critical: 0,
    databaseFailure: undefined as unknown,
  };
  const before = await registry.metrics();
  assert.equal(
    await runSweepsOnce([{ name, run, timeoutMs: 1_000 }], [], report),
    1,
  );
  assert.equal(calls, 1);
  assert.deepEqual(report.failed, [name]);
  assert.equal(report.critical, 1);
  assert.equal(report.databaseFailure, error);
  const after = await registry.metrics();
  assert.doesNotMatch(
    after,
    new RegExp(
      `valo_sweep_last_success_by_sweep_timestamp_seconds\\{sweep="${name}"\\}`,
    ),
  );
  const recovery = (text: string) =>
    text
      .split("\n")
      .filter((line) =>
        line.startsWith(
          'valo_worker_database_recovery_total{worker="compliance"',
        ),
      );
  assert.deepEqual(recovery(after), recovery(before));
});

test("shutdown aborts cooperatively but waits for actual settlement and refuses new work", async () => {
  let finish!: () => void;
  let start!: () => void;
  let signal!: AbortSignal;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const pass = runSweepsOnce([
    {
      name: `test.shutdown_${SALT}`,
      timeoutMs: 1_000,
      run: (abort) => {
        signal = abort;
        start();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    },
  ]);
  await started;
  try {
    stopWorker();
    assert.equal(signal.aborted, true);
    assert.equal(await awaitWorkerIdle(5), false);
    assert.equal(
      await runSweepsOnce([
        {
          name: `test.stopped_${SALT}`,
          timeoutMs: 100,
          run: async () => {
            assert.fail("must not start while stopping");
          },
        },
      ]),
      1,
    );
  } finally {
    finish();
    resumeWorker();
  }
  await pass;
  assert.equal(await awaitWorkerIdle(100), true);
});

test("awaitWorkerIdle answers true when nothing is in flight", async () => {
  assert.equal(inFlightPasses(), 0);
  assert.equal(await awaitWorkerIdle(10), true);
});

test("a pass runs every critical sweep before any best-effort one, registration order within each (R106)", () => {
  const sweeps = [
    { name: "a.best", critical: false },
    { name: "b.critical" },
    { name: "c.best", critical: false },
    { name: "d.critical", critical: true },
  ];
  assert.deepEqual(
    orderedSweeps(sweeps).map((s) => s.name),
    ["b.critical", "d.critical", "a.best", "c.best"],
  );
  // The registry listing itself keeps registration order.
  assert.equal(orderedSweeps([]).length, 0);
});
