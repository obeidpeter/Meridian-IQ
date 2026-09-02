import { Router, type IRouter } from "express";
import portfolioRouter from "./portfolio";
import billingRouter from "./billing";
import operatorQueueRouter from "./operator-queue";
import accessRegisterRouter from "./access-register";

// The firm console, its billing surfaces, and the operator desk, split by
// concern (the routes/invoices pattern). Groups are the contiguous section
// families of the original single file, mounted in the original registration
// order. One deliberate carve-out: the bare /rejection-patterns and
// /compliance-calendar reports stay with the portfolio slice (they are
// portfolio rollups, not billing), so they now register before
// /console/unearned-income — safe because every path here is a distinct
// literal or its own :id family; nothing can swallow another group's route.
//   portfolio.ts       client-risk rollups, team, onboarding pipeline, plus
//                      the bare rejection-patterns/compliance-calendar reports
//   billing.ts         unearned income, tiers & subscription, revenue-share
//                      statements
//   operator-queue.ts  the operator work queue (CON-04) + escalation replies
//   shared.ts          PRIORITY_RANK — the sort rank both queues share

const router: IRouter = Router();

router.use(portfolioRouter);
router.use(billingRouter);
router.use(operatorQueueRouter);
// access-register.ts  the lightweight access review (D14): register + attest
router.use(accessRegisterRouter);

export default router;
