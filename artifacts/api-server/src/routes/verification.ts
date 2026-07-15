import { Router, type IRouter } from "express";
import {
  VerifyStampBody,
  VerifyStampResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { verifyStamp } from "../modules/rails/adapter";

const router: IRouter = Router();

// Public stamp verification (CORE-04). Any party (buyer, bank, auditor) can
// verify an IRN/CSID pair; results are served from a freshness cache.
router.post("/verify-stamp", async (req, res): Promise<void> => {
  const parsed = parseOrThrow(VerifyStampBody, req.body);
  const result = await verifyStamp(parsed.irn, parsed.csid);
  res.json(VerifyStampResponse.parse(result));
});

export default router;
