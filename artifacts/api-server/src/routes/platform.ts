import { Router, type IRouter } from "express";
import {
  ListFeatureFlagsResponse,
  UpdateFeatureFlagParams,
  UpdateFeatureFlagBody,
  SetFeatureFlagOverrideParams,
  SetFeatureFlagOverrideBody,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import { listFlags, setFlag, setFirmOverride } from "../modules/flags/flags";

const router: IRouter = Router();

router.get("/feature-flags", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.read");
  res.json(ListFeatureFlagsResponse.parse(await listFlags()));
});

router.patch("/feature-flags/:key", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = parseOrThrow(UpdateFeatureFlagParams, req.params);
  const parsed = parseOrThrow(UpdateFeatureFlagBody, req.body);
  await setFlag(params.key, parsed.enabled);
  res.sendStatus(204);
});

router.post("/feature-flags/:key/override", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = parseOrThrow(SetFeatureFlagOverrideParams, req.params);
  const parsed = parseOrThrow(SetFeatureFlagOverrideBody, req.body);
  await setFirmOverride(params.key, parsed.firmId, parsed.enabled);
  res.sendStatus(204);
});

export default router;
