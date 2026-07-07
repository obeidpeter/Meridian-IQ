import { Router, type IRouter } from "express";
import {
  SendMessageBody,
  SendMessageResponse,
  RecordMessageDeliveryParams,
  RecordMessageDeliveryBody,
} from "@workspace/api-zod";
import { sendMessage, markDelivery } from "../modules/messaging/messaging";

const router: IRouter = Router();

router.post("/messages", async (req, res): Promise<void> => {
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
