import { Router, type IRouter } from "express";
import { desc } from "drizzle-orm";
import { getDb, messagesTable } from "@workspace/db";
import {
  SendMessageBody,
  SendMessageResponse,
  RecordMessageDeliveryParams,
  RecordMessageDeliveryBody,
  ListMessagesResponse,
  ListNotificationsQueryParams,
  ListNotificationsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { sendMessage, markDelivery } from "../modules/messaging/messaging";
import { listNotificationsFor } from "../modules/messaging/inbox";
import { assertCan } from "../modules/auth/rbac";
import { requireFlag } from "../modules/flags/flags";

const router: IRouter = Router();

// Notifications ship dark behind the messaging_notifications flag (PL-02): a
// dark feature is unreachable, so every route 404s until the flag is flipped.

// PL-04 delivery visibility: the operator's message log. Rows are pointers
// only (SEC-12) — template key, channel, status — so no tenant data leaks
// across the cross-tenant read.
router.get("/messages", requireFlag("messaging_notifications"), async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb()
    .select()
    .from(messagesTable)
    .orderBy(desc(messagesTable.createdAt))
    .limit(50);
  res.json(ListMessagesResponse.parse(rows));
});

router.post("/messages", requireFlag("messaging_notifications"), async (req, res): Promise<void> => {
  assertCan(req.principal, "messaging.send");
  const parsed = parseOrThrow(SendMessageBody, req.body);
  const row = await sendMessage({
    channel: parsed.channel,
    recipientRef: parsed.recipientRef,
    templateKey: parsed.templateKey,
    entityType: parsed.entityType,
    entityId: parsed.entityId,
  });
  res.status(201).json(SendMessageResponse.parse(row));
});

router.post("/messages/:id/delivery", requireFlag("messaging_notifications"), async (req, res): Promise<void> => {
  assertCan(req.principal, "messaging.send");
  const params = parseOrThrow(RecordMessageDeliveryParams, req.params);
  const parsed = parseOrThrow(RecordMessageDeliveryBody, req.body);
  await markDelivery(params.id, parsed.delivered);
  res.sendStatus(204);
});

// The signed-in user's own notification feed. Deliberately NOT behind the
// messaging_notifications flag: that flag gates SEND behaviour — creating
// ledger rows and touching providers. Reading rows already addressed to you
// creates nothing and sends nothing, and a feed that 404s while past sends
// exist would only hide the user's own history (a dark deployment simply has
// an empty ledger, so the feed is naturally empty). No assertCan either: any
// authenticated principal may read its OWN feed — the per-principal
// recipient_ref resolution inside listNotificationsFor is the wall (SEC-03),
// and roles with no recipient identity in the ledger get an empty list.
router.get("/notifications", async (req, res): Promise<void> => {
  const query = parseOrThrow(ListNotificationsQueryParams, req.query);
  const items = await listNotificationsFor(req.principal, query.limit ?? 50);
  res.json(ListNotificationsResponse.parse({ items }));
});

export default router;
