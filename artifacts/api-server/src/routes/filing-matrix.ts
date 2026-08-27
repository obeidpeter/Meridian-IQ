import { Router, type IRouter } from "express";
import { GetFilingMatrixResponse } from "@workspace/api-zod";
import { assertCan, firmScope } from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";
import { computeFilingMatrix } from "../modules/filings/filing-matrix";

// Filing Desk Phase 3 (contract 0.68.0): the firm's current-period filing
// status across every client — the /console/vat-positions posture EXACTLY
// (console.portfolio.read + firmScope, rbac's ONE definition), so the matrix
// carries the same gate as the existing firm rollups by construction. Firm
// principals only: a client_user must never see sibling clients' filing
// statuses.
// NOTE: this router is NOT self-registering — it is mounted in
// routes/index.ts.

const router: IRouter = Router();

// Launch-profile gate (PL-02): the whole surface rides the statutory_desks flag —
// dark means 404 on every route here (per-firm overrides apply).
router.use(requireFlag("statutory_desks"));

router.get("/console/filing-matrix", async (req, res): Promise<void> => {
  assertCan(req.principal, "console.portfolio.read");
  const firmId = firmScope(req.principal);
  const matrix = await computeFilingMatrix(firmId);
  res.json(GetFilingMatrixResponse.parse(matrix));
});

export default router;
