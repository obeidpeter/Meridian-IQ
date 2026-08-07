import { registerSweep } from "../pipeline/pipeline";
import { atMostHourly } from "../clerk/watch-shared";
import { sweepOnboardingRuns } from "./sweep";

// Wires the onboarding refresh sweep onto the shared 1-minute loop, wrapped
// atMostHourly (the filings/register.ts pattern): onboarding facts move at
// human pace — an upload, a consent grant, a month boundary — so the hourly
// cadence keeps the recomputation off the minute loop while the checklist
// still follows within the hour. Kept out of sweep.ts so that module stays
// importable by node --test without the pipeline worker's dependency graph.
registerSweep(atMostHourly(() => sweepOnboardingRuns()));
