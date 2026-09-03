// The rail soak (R102): the real submission pipeline over two conformance
// fake rails under a seeded fault mix, several workers at once, then every
// invariant checked. Exit 1 on any violation.
//
//   DATABASE_URL=... pnpm --filter @workspace/api-server run soak [invoices] [workers] [seed]
//
// Defaults: 500 invoices, 6 workers, seed 7, a 10 minute deadline. Runs
// against a SCRATCH database (it seeds a firm and leaves the rows behind).

import { requireDatabaseUrl } from "@workspace/db";
import { runRailSoak } from "../modules/pipeline/soak";
import { stopWorker } from "../modules/pipeline/pipeline";

async function main(): Promise<void> {
  requireDatabaseUrl();
  const invoices = Number(process.argv[2] ?? 500);
  const workers = Number(process.argv[3] ?? 6);
  const seed = Number(process.argv[4] ?? 7);
  const report = await runRailSoak({
    invoices,
    workers,
    seed,
    deadlineMs: 10 * 60 * 1000,
    log: (line) => console.log(`[soak] ${line}`),
  });
  console.log(JSON.stringify(report, null, 2));
  stopWorker();
  process.exit(report.ok ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
