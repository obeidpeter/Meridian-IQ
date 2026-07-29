import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  detectPhrasingQualityDrop,
  sweepPhrasingWatch,
} from "./phrasing-watch.ts";

// Nightly phrasing watch (round-20 idea #1). Pinned invariants:
//  - detection is RATE-based, so corpus growth between rounds never reads
//    as a regression;
//  - the baseline is the aggregate of up to five prior runs (one flaky
//    old run cannot dominate), and fewer than the floor stays quiet;
//  - resistance wins the report when both rates dropped — it is the
//    safety metric;
//  - the alert is once-only per degraded run (audit-ledger dedup).

function run(over: {
  fixtureCount?: number;
  groundedCount?: number;
  injectionFixtures?: number;
  injectionResisted?: number;
}) {
  return {
    id: randomUUID(),
    fixtureCount: over.fixtureCount ?? 20,
    groundedCount: over.groundedCount ?? 20,
    injectionFixtures: over.injectionFixtures ?? 5,
    injectionResisted: over.injectionResisted ?? 5,
  };
}

test("detection is rate-based and needs a real baseline", () => {
  // Perfect history, perfect newest: quiet.
  const steady = [run({}), run({}), run({}), run({})];
  assert.equal(detectPhrasingQualityDrop(steady), null);

  // Only two prior runs: under the baseline floor, quiet even on a crash.
  assert.equal(
    detectPhrasingQualityDrop([
      run({ injectionResisted: 0 }),
      run({}),
      run({}),
    ]),
    null,
  );

  // Resistance crash vs a clean baseline: alert, resistance metric.
  const crash = detectPhrasingQualityDrop([
    run({ injectionResisted: 3 }), // 60% vs 100% baseline
    run({}),
    run({}),
    run({}),
  ]);
  assert.ok(crash);
  assert.equal(crash.metric, "resistance");
  assert.equal(crash.baselineRate, 1);
  assert.equal(crash.newestRate, 0.6);

  // Grounding slide with resistance intact: the grounding metric reports.
  const slide = detectPhrasingQualityDrop([
    run({ groundedCount: 15 }), // 75% vs 100%
    run({}),
    run({}),
    run({}),
  ]);
  assert.ok(slide && slide.metric === "grounded");

  // Both dropped: resistance wins the report.
  const both = detectPhrasingQualityDrop([
    run({ groundedCount: 10, injectionResisted: 2 }),
    run({}),
    run({}),
    run({}),
  ]);
  assert.ok(both && both.metric === "resistance");

  // Corpus GROWTH with steady rates: never a regression. Old runs had 14
  // fixtures / 3 injections, the newest has 20/5 — all perfect.
  const grown = detectPhrasingQualityDrop([
    run({}),
    run({ fixtureCount: 14, groundedCount: 14, injectionFixtures: 3, injectionResisted: 3 }),
    run({ fixtureCount: 14, groundedCount: 14, injectionFixtures: 3, injectionResisted: 3 }),
    run({ fixtureCount: 14, groundedCount: 14, injectionFixtures: 3, injectionResisted: 3 }),
  ]);
  assert.equal(grown, null);

  // A drop smaller than the threshold stays quiet (19/20 grounded = -5pts).
  assert.equal(
    detectPhrasingQualityDrop([
      run({ groundedCount: 19 }),
      run({}),
      run({}),
      run({}),
    ]),
    null,
  );
});

test("the sweep alerts once per degraded run and dedups after", async () => {
  const degraded = [
    run({ injectionResisted: 2 }),
    run({}),
    run({}),
    run({}),
  ];
  const first = await sweepPhrasingWatch({ runs: async () => degraded });
  assert.deepEqual(first, { checked: true, dropped: true, alerted: true });
  // Same degraded run again: detected, but the audit ledger dedups.
  const second = await sweepPhrasingWatch({ runs: async () => degraded });
  assert.deepEqual(second, { checked: true, dropped: true, alerted: false });
  // A healthy history: nothing to do.
  const healthy = await sweepPhrasingWatch({
    runs: async () => [run({}), run({}), run({}), run({})],
  });
  assert.deepEqual(healthy, { checked: true, dropped: false, alerted: false });
});
