import { Router, type IRouter } from "express";
import casesRouter from "./cases";
import evalRouter from "./eval";
import askRouter from "./ask";
import batchesRouter from "./batches";
import reportsRouter from "./reports";
import draftsRouter from "./drafts";

// Clerk copilot surface (Task #40 + expansion A). Shadow-mode throughout:
// extraction proposes, a human disposes, and approval can only create a DRAFT
// invoice. Capture (clerk.capture) and Ask (clerk.ask) are open to firm
// principals — pinned to their firm (route filters + the 0009 RLS policy),
// with a client_user further narrowed to cases it submitted itself — and are
// budget-capped per firm BEFORE any provider work. Review/decide/claim/retry,
// evals, metrics and party suggestions stay operator-only (clerk.use). The
// kill switch (clerk_ai flag) is enforced inside the gateway and module code,
// so a disabled Clerk fails closed with 503 CLERK_DISABLED before any model
// call or case insert. Audit entries are appended by the modules themselves.
//
// The surface is split by concern (every path is absolute, so mount order
// only matters for overlapping paths — there are none across the groups):
//   cases.ts    capture, review decisions, claim/release/retry, suggestions
//   eval.ts     eval runs, corpus curation, prompt + model canaries
//   ask.ts      Ask Clerk, failure explainer, payment-chaser draft
//   batches.ts  async batch intake
//   reports.ts  metrics, claim gaps, tier report, usage, digest, statements
//   drafts.ts   format/import/invoice/claims/catalogue drafting + assist

const router: IRouter = Router();

router.use(casesRouter);
router.use(evalRouter);
router.use(askRouter);
router.use(batchesRouter);
router.use(reportsRouter);
router.use(draftsRouter);

export default router;
