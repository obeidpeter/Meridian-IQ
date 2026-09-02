import { Router, type IRouter } from "express";
import {
  ListFeatureFlagsResponse,
  UpdateFeatureFlagParams,
  UpdateFeatureFlagBody,
  ListFeatureFlagOverridesParams,
  ListFeatureFlagOverridesResponse,
  SetFeatureFlagOverrideParams,
  SetFeatureFlagOverrideBody,
  SetFeatureFlagOverrideResponse,
  ClearFeatureFlagOverrideParams,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import { appendAudit } from "../modules/audit/audit";
import { DomainError } from "../modules/errors";
import {
  clearFirmOverride,
  listFirmOverrides,
  listFlags,
  setFlag,
  setFirmOverride,
} from "../modules/flags/flags";

// The activation control plane (PL-02, R99). Every flag flip and every
// pilot override lands on the audit chain with the actor and the reason:
// `flag.update` for the platform-wide switch, `flag.override.set` /
// `flag.override.clear` for a firm's cohort membership (firmId on the audit
// row is the TARGET firm — the operator has none). A cleared override is
// not an `enabled: false` one: clearing hands the firm back to the platform
// default, an explicit false darkens it even while the platform flag is lit.

const router: IRouter = Router();

router.get("/feature-flags", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.read");
  res.json(ListFeatureFlagsResponse.parse(await listFlags()));
});

router.patch("/feature-flags/:key", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = parseOrThrow(UpdateFeatureFlagParams, req.params);
  const parsed = parseOrThrow(UpdateFeatureFlagBody, req.body);
  const { before, after } = await setFlag(params.key, parsed.enabled);
  await appendAudit({
    actorId: req.principal.userId,
    actorRole: req.principal.role,
    firmId: null,
    action: "flag.update",
    entityType: "feature_flag",
    entityId: params.key,
    before: { enabled: before.enabled },
    after: { enabled: after.enabled, reason: parsed.reason ?? null },
  });
  res.sendStatus(204);
});

router.get(
  "/feature-flags/:key/overrides",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "flags.read");
    const params = parseOrThrow(ListFeatureFlagOverridesParams, req.params);
    res.json(
      ListFeatureFlagOverridesResponse.parse(
        await listFirmOverrides(params.key),
      ),
    );
  },
);

router.post("/feature-flags/:key/override", async (req, res): Promise<void> => {
  assertCan(req.principal, "flags.write");
  const params = parseOrThrow(SetFeatureFlagOverrideParams, req.params);
  const parsed = parseOrThrow(SetFeatureFlagOverrideBody, req.body);
  const reason = parsed.reason.trim();
  if (reason.length < 3) {
    throw new DomainError("VALIDATION", "A reason is required", 400);
  }
  const { before, after } = await setFirmOverride(
    params.key,
    parsed.firmId,
    parsed.enabled,
    { actorId: req.principal.userId, reason },
  );
  await appendAudit({
    actorId: req.principal.userId,
    actorRole: req.principal.role,
    firmId: parsed.firmId,
    action: "flag.override.set",
    entityType: "feature_flag_override",
    entityId: `${params.key}:${parsed.firmId}`,
    before: before ? { enabled: before.enabled, reason: before.reason } : null,
    after: { enabled: after.enabled, reason: after.reason },
  });
  res.json(SetFeatureFlagOverrideResponse.parse(after));
});

router.delete(
  "/feature-flags/:key/override/:firmId",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "flags.write");
    const params = parseOrThrow(ClearFeatureFlagOverrideParams, req.params);
    const cleared = await clearFirmOverride(params.key, params.firmId);
    if (!cleared) {
      throw new DomainError(
        "OVERRIDE_NOT_FOUND",
        "This firm has no override on that flag",
        404,
      );
    }
    await appendAudit({
      actorId: req.principal.userId,
      actorRole: req.principal.role,
      firmId: params.firmId,
      action: "flag.override.clear",
      entityType: "feature_flag_override",
      entityId: `${params.key}:${params.firmId}`,
      before: { enabled: cleared.enabled, reason: cleared.reason },
    });
    res.sendStatus(204);
  },
);

export default router;
