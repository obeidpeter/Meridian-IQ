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
import { parseOrThrow } from "../lib/parse";
import { assertCan, assertPartyAccess } from "../modules/auth/rbac";
import {
  consentHistory,
  recordConsent,
  isPurposePermitted,
  PURPOSE_LAYER,
} from "../modules/consent/consent";

const router: IRouter = Router();

router.get("/parties/:id/consent", async (req, res): Promise<void> => {
  assertCan(req.principal, "consent.read");
  const params = parseOrThrow(ListConsentParams, req.params);
  await assertPartyAccess(req.principal, params.id);
  const rows = await consentHistory(params.id);
  res.json(ListConsentResponse.parse(rows));
});

router.post("/parties/:id/consent", async (req, res): Promise<void> => {
  assertCan(req.principal, "consent.write");
  const params = parseOrThrow(RecordConsentParams, req.params);
  await assertPartyAccess(req.principal, params.id);
  const parsed = parseOrThrow(RecordConsentBody, req.body);
  const row = await recordConsent({
    partyId: params.id,
    layer: parsed.layer,
    action: parsed.action,
    scope: parsed.scope,
    basis: parsed.basis,
    channel: parsed.channel,
    actorId: req.principal.userId,
  });
  res.status(201).json(RecordConsentResponse.parse(row));
});

router.get(
  "/parties/:id/consent/check/:purpose",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "consent.read");
    const params = parseOrThrow(CheckConsentParams, req.params);
    await assertPartyAccess(req.principal, params.id);
    const permitted = await isPurposePermitted(
      params.id,
      params.purpose,
    );
    res.json(
      CheckConsentResponse.parse({
        purpose: params.purpose,
        permitted,
        layer: PURPOSE_LAYER[params.purpose] ?? null,
      }),
    );
  },
);

export default router;
