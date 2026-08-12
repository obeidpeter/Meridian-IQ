import { Router, type IRouter } from "express";
import dashboardRouter from "./dashboard";
import importRouter from "./import";
import alertPrefsRouter from "./alert-prefs";
import escalationsRouter from "./escalations";

// The SME client-app surface, split by concern (the routes/invoices pattern).
// Groups are the CONTIGUOUS slices of the original single file, mounted in
// the original registration order.
//   dashboard.ts    summary, receivables (+ CSV export), cashflow outlook,
//                   net position, chase list, compliance calendar
//                   (computeDeadlines — the SME-05/SME-08 deadline book)
//   import.ts       spreadsheet invoice import (SME-02; NFR-03 bulk path)
//   alert-prefs.ts  per-client alert preferences + the test-alert fan-out
//   escalations.ts  invoice escalations into the Compliance Desk (SME-06)

const router: IRouter = Router();

router.use(dashboardRouter);
router.use(importRouter);
router.use(alertPrefsRouter);
router.use(escalationsRouter);

export default router;
