import { Router, type IRouter, type Request, type Response } from "express";
import {
  SendMessageBody,
  SendMessageResponse,
  RecordMessageDeliveryParams,
  RecordMessageDeliveryBody,
} from "@workspace/api-zod";
import { sendMessage, markDelivery } from "../modules/messaging/messaging";
import { assertCan } from "../modules/auth/rbac";
import { isFeatureEnabled } from "../modules/flags/flags";

const router: IRouter = Router();

// Notifications ship dark behind the messaging_notifications flag (PL-02): a
// dark feature is unreachable, so the route 404s until the flag is flipped.
async function assertMessagingEnabled(
  req: Request,
  res: Response,
): Promise<boolean> {
  const on = await isFeatureEnabled(
    "messaging_notifications",
    req.principal.firmId,
  );
  if (!on) {
    res.sendStatus(404);
    return false;
  }
  return true;
}

router.post("/messages", async (req, res): Promise<void> => {
  if (!(await assertMessagingEnabled(req, res))) return;
  assertCan(req.principal, "messaging.send");
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const row = await sendMessage({
    channel: parsed.data.channel,
    recipientRef: parsed.data.recipientRef,
    templateKey: parsed.data.templateKey,
    entityType: parsed.data.entityType,
    entityId: parsed.data.entityId,
  });
  res.status(201).json(SendMessageResponse.parse(row));
});

router.post("/messages/:id/delivery", async (req, res): Promise<void> => {
  if (!(await assertMessagingEnabled(req, res))) return;
  assertCan(req.principal, "messaging.send");
  const params = RecordMessageDeliveryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const parsed = RecordMessageDeliveryBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  await markDelivery(params.data.id, parsed.data.delivered);
  res.sendStatus(204);
});

export default router;
