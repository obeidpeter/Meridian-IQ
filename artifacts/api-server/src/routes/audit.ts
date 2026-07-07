import { Router, type IRouter } from "express";
import { VerifyAuditResponse, ExportAuditResponse } from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import { verifyChain, exportAuditBundle } from "../modules/audit/audit";

const router: IRouter = Router();

router.get("/audit/verify", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.read");
  res.json(VerifyAuditResponse.parse(await verifyChain()));
});

router.get("/audit/export", async (req, res): Promise<void> => {
  assertCan(req.principal, "audit.export");
  res.json(ExportAuditResponse.parse(await exportAuditBundle()));
});

export default router;
