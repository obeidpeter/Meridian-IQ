import { Router, type IRouter } from "express";
import collectionRouter from "./collection";
import packsRouter from "./packs";
import advisoriesRouter from "./advisories";
import lifecycleRouter from "./lifecycle";
import documentsRouter from "./documents";
import railsRouter from "./rails";

// The invoice data spine and its report surfaces, split by concern (the
// routes/clerk pattern). Groups are the CONTIGUOUS slices of the original
// single file, mounted in the original registration order — which is
// load-bearing twice: /invoices/export (collection) and /invoices/bulk-submit
// (lifecycle, before its own :id family) are literal paths that a
// later-mounted /invoices/:id would otherwise swallow. Keep new literal
// /invoices/<word> routes in a group mounted before lifecycle, or before the
// :id family within it.
//   collection.ts  list, create, CSV export (+ the shared list conditions)
//   packs.ts       VAT pack family, quarterly review, billing statement
//   advisories.ts  the deterministic client-scoped miners and reports
//   lifecycle.ts   single get/fix, validate/submit/bulk-submit, approvals,
//                  cancel, credit-note, chase-log
//   documents.ts   PDF/UBL/canonical, stamp, attempts, status light, risk
//   rails.ts       buyer confirmations (BR-02) and settlement evidence
//   shared.ts      loadForTenant — the SEC-03 single-invoice scope gate

const router: IRouter = Router();

router.use(collectionRouter);
router.use(packsRouter);
router.use(advisoriesRouter);
router.use(lifecycleRouter);
router.use(documentsRouter);
router.use(railsRouter);

export { loadForTenant } from "./shared";
export default router;
