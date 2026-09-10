import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { getDb, alertPreferencesTable } from "@workspace/db";
import {
  GetAlertPreferencesParams,
  GetAlertPreferencesResponse,
  UpdateAlertPreferencesParams,
  UpdateAlertPreferencesBody,
  UpdateAlertPreferencesResponse,
  SendTestAlertParams,
  SendTestAlertResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../../lib/parse";
import {
  assertCan,
  assertPartyAccess,
  type Principal,
} from "../../modules/auth/rbac";
import { sendMessage } from "../../modules/messaging/messaging";
import { recipientRefFor } from "../../modules/messaging/recipient-ref";
import { sendPushAlert } from "../../modules/push/push";
import { appendAudit } from "../../modules/audit/audit";

const router: IRouter = Router();

const DEFAULT_PREFS = {
  whatsappEnabled: true,
  smsEnabled: false,
  emailEnabled: true,
  pushEnabled: true,
  whatsappTo: null,
  phone: null,
  email: null,
  deadlineAlerts: true,
  failureAlerts: true,
  penaltyAlerts: true,
};

router.get(
  "/clients/:id/alert-preferences",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "invoice.read");
    const params = parseOrThrow(GetAlertPreferencesParams, req.params);
    await assertPartyAccess(req.principal, params.id);
    const [row] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(eq(alertPreferencesTable.clientPartyId, params.id))
      .limit(1);
    const prefs = row ?? {
      clientPartyId: params.id,
      ...DEFAULT_PREFS,
      updatedAt: new Date(),
    };
    res.json(GetAlertPreferencesResponse.parse(prefs));
  },
);

// Alert preferences are managed by firm staff (messaging.send) AND by the SME
// client itself: a client_user may update the preferences of its own client
// party — assertPartyAccess below pins client_user to exactly that party — but
// holds no general messaging capability.
function assertCanManageAlerts(principal: Principal): void {
  if (principal.role === "client_user") return;
  assertCan(principal, "messaging.send");
}

router.put(
  "/clients/:id/alert-preferences",
  async (req, res): Promise<void> => {
    assertCanManageAlerts(req.principal);
    const params = parseOrThrow(UpdateAlertPreferencesParams, req.params);
    const parsed = parseOrThrow(UpdateAlertPreferencesBody, req.body);
    await assertPartyAccess(req.principal, params.id);
    // Contact-number provenance (see modules/inbound/whatsapp.ts): whenever the
    // payload names a routing-key field (whatsappTo/phone), record WHICH role
    // wrote it — the inbound WhatsApp rail only routes on numbers the client
    // set themselves. A PUT that never names those fields (e.g. staff toggling
    // a channel) leaves the existing provenance untouched.
    const touchesContact =
      parsed.whatsappTo !== undefined || parsed.phone !== undefined;
    const provenance = touchesContact
      ? { contactSetByRole: req.principal.role }
      : {};
    const values = {
      clientPartyId: params.id,
      ...DEFAULT_PREFS,
      ...parsed,
      ...provenance,
    };
    const [row] = await getDb()
      .insert(alertPreferencesTable)
      .values(values)
      .onConflictDoUpdate({
        target: alertPreferencesTable.clientPartyId,
        set: { ...parsed, ...provenance, updatedAt: new Date() },
      })
      .returning();
    await appendAudit({
      actorId: req.principal.userId,
      firmId: req.principal.firmId,
      action: "alert.preferences.update",
      entityType: "alert_preferences",
      entityId: params.id,
      after: parsed,
    });
    res.json(UpdateAlertPreferencesResponse.parse(row));
  },
);

router.post("/clients/:id/alerts/test", async (req, res): Promise<void> => {
  assertCanManageAlerts(req.principal);
  const params = parseOrThrow(SendTestAlertParams, req.params);
  await assertPartyAccess(req.principal, params.id);
  const [row] = await getDb()
    .select()
    .from(alertPreferencesTable)
    .where(eq(alertPreferencesTable.clientPartyId, params.id))
    .limit(1);
  const prefs = row ?? { ...DEFAULT_PREFS, clientPartyId: params.id };
  const recipientRef = recipientRefFor(params.id);

  const enabled: ("whatsapp" | "sms" | "email")[] = [];
  if (prefs.whatsappEnabled) enabled.push("whatsapp");
  if (prefs.smsEnabled) enabled.push("sms");
  if (prefs.emailEnabled) enabled.push("email");

  const results: {
    channel: "whatsapp" | "sms" | "email" | "push";
    messageId: string | null;
    status: "sent" | "delivered" | "failed" | "skipped";
    detail: string | null;
  }[] = [];
  for (const channel of enabled) {
    try {
      const message = await sendMessage({
        channel,
        recipientRef,
        // Real recipient identity for the ledger/feed (the ref is display
        // and correlation only).
        recipientPartyId: params.id,
        templateKey: "deadline_reminder",
      });
      results.push({
        channel,
        messageId: message.providerMessageId ?? null,
        status: message.status === "failed" ? "failed" : "sent",
        detail:
          message.failoverFrom && message.failoverFrom !== channel
            ? `Delivered via ${message.channel} after ${message.failoverFrom} failed`
            : null,
      });
    } catch (err) {
      // Generic detail only: raw provider/internal error text is a log
      // concern, not a client payload (same posture as the error boundary).
      req.log.warn({ err, channel }, "test alert send failed");
      results.push({
        channel,
        messageId: null,
        status: "failed",
        detail: "Send failed",
      });
    }
  }
  if (prefs.pushEnabled) {
    const push = await sendPushAlert({
      clientPartyId: params.id,
      firmId: req.principal.firmId,
      templateKey: "deadline_reminder",
    });
    results.push({ channel: "push", ...push });
  }
  res.json(SendTestAlertResponse.parse(results));
});

export default router;
