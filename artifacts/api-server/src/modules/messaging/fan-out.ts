import type { AlertPreferences } from "@workspace/db";
import { sendMessage } from "./messaging";
import { recipientRefFor } from "./recipient-ref";
import { sendPushAlert, type PushTemplateKey } from "../push/push";

// Shared alert fan-out for the compliance sweeps (deadline reminders, B2C
// pre-breach alerts): the messaging rail per enabled channel (each send with
// its own failover; failures are recorded in the messages ledger by the
// module) plus push, pointer-only payloads throughout (SEC-12).
export async function fanOutAlert(input: {
  // The client's alert_preferences row, or undefined when none exists (the
  // table defaults then apply: whatsapp/email/push on).
  prefs: AlertPreferences | undefined;
  clientPartyId: string;
  firmId: string | null;
  templateKey: PushTemplateKey;
  entityType: string;
  entityId: string;
  // SMS behaviour when no alert_preferences row exists. Explicit because the
  // two historical callers disagree: deadline reminders default SMS OFF (the
  // table default) while B2C pre-breach alerts default SMS ON. Do not unify
  // the defaults here without a deliberate product decision.
  smsDefaultWhenNoPrefs: boolean;
}): Promise<void> {
  const { prefs } = input;
  const channels: ("whatsapp" | "sms" | "email")[] = [];
  if (!prefs || prefs.whatsappEnabled) channels.push("whatsapp");
  if (prefs ? prefs.smsEnabled : input.smsDefaultWhenNoPrefs)
    channels.push("sms");
  if (!prefs || prefs.emailEnabled) channels.push("email");

  for (const channel of channels) {
    try {
      await sendMessage({
        channel,
        recipientRef: recipientRefFor(input.clientPartyId),
        templateKey: input.templateKey,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    } catch {
      // Channel failures are recorded in the messages ledger by the module.
    }
  }
  if (!prefs || prefs.pushEnabled) {
    try {
      await sendPushAlert({
        clientPartyId: input.clientPartyId,
        firmId: input.firmId,
        templateKey: input.templateKey,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    } catch {
      // Push failures are likewise recorded by the push module.
    }
  }
}
