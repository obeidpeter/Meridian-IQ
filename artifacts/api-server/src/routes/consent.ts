import { Router, type IRouter } from "express";
import {
  ListConsentParams,
  ListConsentResponse,
  RecordConsentBody,
  RecordConsentParams,
  RecordConsentResponse,
  CheckConsentParams,
  CheckConsentResponse,
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import {
  consentHistory,
  recordConsent,
  isPurposePermitted,
  PURPOSE_LAYER,
} from "../modules/consent/consent";

const router: IRouter = Router();

router.get("/parties/:id/consent", async (req, res): Promise<void> => {
  assertCan(req.principal, "consent.read");
  const params = ListConsentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rows = await consentHistory(params.data.id);
  res.json(ListConsentResponse.parse(rows));
});

router.post("/parties/:id/consent", async (req, res): Promise<void> => {
  assertCan(req.principal, "consent.write");
  const params = RecordConsentParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RecordConsentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const row = await recordConsent({
    partyId: params.data.id,
    layer: parsed.data.layer,
    action: parsed.data.action,
    scope: parsed.data.scope,
    basis: parsed.data.basis,
    channel: parsed.data.channel,
    actorId: req.principal.userId,
  });
  res.status(201).json(RecordConsentResponse.parse(row));
});

router.get(
  "/parties/:id/consent/check/:purpose",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "consent.read");
    const params = CheckConsentParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const permitted = await isPurposePermitted(
      params.data.id,
      params.data.purpose,
    );
    res.json(
      CheckConsentResponse.parse({
        purpose: params.data.purpose,
        permitted,
        layer: PURPOSE_LAYER[params.data.purpose] ?? null,
      }),
    );
  },
);

export default router;
