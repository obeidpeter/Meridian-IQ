import { registerSweep } from "../pipeline/pipeline";
import { atMostHourly } from "../clerk/watch-shared";
import { sweepFilingMint } from "./sweep";

// Wires the filing mint sweep onto the shared 1-minute loop (the
// obligations/register.ts pattern), wrapped atMostHourly: minting is MONTHLY
// work — a new period only appears at a Lagos month boundary — so the hourly
// cadence keeps it off the minute loop while a fresh period still lands
// within the hour. Kept out of sweep.ts so that module stays importable by
// node --test without the pipeline worker's dependency graph.
registerSweep(atMostHourly(() => sweepFilingMint()));
