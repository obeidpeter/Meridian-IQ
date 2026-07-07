import { Router, type IRouter } from "express";
import {
  ListFeatureFlagsResponse,
  UpdateFeatureFlagParams,
  UpdateFeatureFlagBody,
  SetFeatureFlagOverrideParams,
  SetFeatureFlagOverrideBody,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import { listFlags, setFlag, setFirmOverride } from "../modules/flags/flags";

const router: IRouter = Router();

router.get("/feature-flags", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.read");
  res.json(ListFeatureFlagsResponse.parse(await listFlags()));
});

router.patch("/feature-flags/:key", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = UpdateFeatureFlagParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = UpdateFeatureFlagBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setFlag(params.data.key, parsed.data.enabled);
  res.sendStatus(204);
});

router.post("/feature-flags/:key/override", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = SetFeatureFlagOverrideParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = SetFeatureFlagOverrideBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await setFirmOverride(params.data.key, parsed.data.firmId, parsed.data.enabled);
  res.sendStatus(204);
});

export default router;
