import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  registerSweep,
  unregisterSweep,
  listSweeps,
  orderedSweeps,
  runSweepsOnce,
  awaitWorkerIdle,
  inFlightPasses,
  SweepTimeoutError,
  stopWorker,
  resumeWorker,
  type RegisteredSweep,
} from "./pipeline.ts";
import { registry } from "../../lib/metrics.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";

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
