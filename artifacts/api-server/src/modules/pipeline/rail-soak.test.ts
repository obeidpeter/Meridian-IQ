import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setRailTransport } from "../rails/adapter.ts";
import { clearRailEnv } from "../../test-helpers/rail-env.ts";
import { runRailSoak } from "./soak.ts";

// The CI-sized rail soak (R102): a few dozen invoices through the real
// pipeline over two conformance fake rails with the seeded fault mix and
// four concurrent drain loops. Every invariant in soak.ts must hold; the
// large run is `pnpm --filter @workspace/api-server run soak`.

let restoreEnv: () => void = () => undefined;

before(() => {
  restoreEnv = clearRailEnv();
});
after(() => {
  setRailTransport(null);
  restoreEnv();
});

test("soak: 60 invoices, 4 workers, the seeded fault mix — every invariant holds and it settles", async () => {
  const report = await runRailSoak({
    invoices: 60,
    workers: 4,
    seed: 42,
    deadlineMs: 90_000,
    log: (line) => console.log(`[soak] ${line}`),
  });
  console.log(`[soak] ${JSON.stringify(report.stats)}`);
  assert.deepEqual(report.violations, [], "invariant violations");
  assert.equal(report.ok, true);
  assert.equal(report.stats.settled, true);
  assert.equal(report.stats.stamped + report.stats.failed, 60);
  assert.equal(report.stats.failed, report.stats.byScenario.reject);
  assert.ok(report.stats.retries > 0, "the mix produced retries");
  assert.ok(report.stats.recoveredStamps > 0, "the mix produced recoveries");
  assert.ok(report.stats.stampedVia.rail_secondary > 0, "failover stamped on the secondary rail");
});
