import { Router, type IRouter } from "express";
import {
  VerifyStampBody,
  VerifyStampResponse,
} from "@workspace/api-zod";
import { verifyStamp } from "../modules/rails/adapter";

const router: IRouter = Router();

// Public stamp verification (CORE-04). Any party (buyer, bank, auditor) can
// verify an IRN/CSID pair; results are served from a freshness cache.
router.post("/verify-stamp", async (req, res): Promise<void> => {
  const parsed = VerifyStampBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await verifyStamp(parsed.data.irn, parsed.data.csid);
  res.json(VerifyStampResponse.parse(result));
});

export default router;
