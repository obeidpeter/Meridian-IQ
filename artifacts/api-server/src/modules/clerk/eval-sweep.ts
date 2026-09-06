import { clerkEvalRunsTable, runInBypassContext } from "@workspace/db";
import { tryAdvisoryXactLock } from "../../lib/advisory-lock";
import { logger } from "../../lib/logger";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { runEvalCorpus } from "./eval";
import { growEvalFixtures } from "./eval-growth";
import { getClerkGateway } from "./provider";
import { unattendedRunDueToday } from "./watch-shared";

const AUTO_EVAL_FLAG_KEY = "clerk_auto_eval";
const EVAL_GROWTH_LOCK_ID = 731_842;

registerSweep(
  "clerk.eval_growth",
  async function sweepEvalGrowth(): Promise<void> {
    // The short transaction protects fixture growth. Provider calls happen only
    // after it has committed, so a slow evaluation cannot pin a DB connection.
    const runEval = await runInBypassContext(async () => {
      const locked = await tryAdvisoryXactLock(EVAL_GROWTH_LOCK_ID);
      if (!locked) return false;

      const grown = await growEvalFixtures();
      if (grown > 0) {
        logger.info({ grown }, "clerk learning loop: eval fixtures grown");
      }

      if (!(await isFeatureEnabled(AUTO_EVAL_FLAG_KEY))) return false;
      return unattendedRunDueToday(clerkEvalRunsTable);
    });
    if (!runEval) return;

    const gateway = await getClerkGateway();
    const run = await runEvalCorpus(null, gateway);
    logger.info(
      {
        fixtureCount: run.fixtureCount,
        fieldsCorrect: run.fieldsCorrect,
        fieldsCompared: run.fieldsCompared,
      },
      "clerk learning loop: nightly eval run complete",
    );
  },
  { critical: false },
);
