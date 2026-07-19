import { eq } from "drizzle-orm";
import { getDb, messagesTable, type Message, type MessageChannel } from "@workspace/db";
import { DomainError } from "../errors";

// Messaging abstraction with a strict data boundary (PL-04, SEC-12): the
// gateway carries pointers only — never amounts, names, TINs or documents. The
// API only accepts a template key + opaque entity pointer; a registry defines
// which templates exist and which channels they may use.

export interface MessageTemplate {
  key: string;
  channels: MessageChannel[];
  description: string;
}

export const TEMPLATES: Record<string, MessageTemplate> = {
  deadline_reminder: {
    key: "deadline_reminder",
    channels: ["whatsapp", "sms", "email", "push"],
    description: "A filing/payment deadline is approaching.",
  },
  invoice_stamped: {
    key: "invoice_stamped",
    channels: ["whatsapp", "email"],
    description: "An invoice has been stamped.",
  },
  confirmation_request: {
    key: "confirmation_request",
    channels: ["whatsapp", "sms", "email"],
    description: "A buyer is asked to confirm an invoice.",
  },
  // SME-08: the 24-hour B2C reporting window is approaching breach. Pointer
  // only (SEC-12): the message names no amounts, counts or client details.
  b2c_window_alert: {
    key: "b2c_window_alert",
    channels: ["whatsapp", "sms", "email", "push"],
    description: "A B2C reporting window is about to breach.",
  },
  // Clerk idea #5 delivery: a per-client monthly statement was generated.
  // Pointer only (SEC-12): the message names no month, amounts or counts —
  // the client opens the app to read the statement itself.
  client_statement_ready: {
    key: "client_statement_ready",
    channels: ["whatsapp", "sms", "email", "push"],
    description: "A monthly compliance statement is ready to view.",
  },
  // Weekly firm digest delivery to OPTED-IN firm staff (see
  // staff_notification_preferences; not the CORE-03 client-alert model).
  // Pointer only (SEC-12): the message names no counts or amounts — the staff
  // member opens the console to read the digest itself. Email + push only:
  // those are the two channels the preference row offers.
  firm_digest_ready: {
    key: "firm_digest_ready",
    channels: ["email", "push"],
    description: "The firm's weekly Clerk digest is ready to view.",
  },
};

// Channel failover order when a provider fails. Push is terminal: if the Expo
// push provider rejects, there is no cheaper channel to fall back to that the
// user has not already opted into separately.
const FAILOVER: Record<MessageChannel, MessageChannel | null> = {
  whatsapp: "sms",
  sms: "email",
  email: null,
  push: null,
};

export interface SendInput {
  channel: MessageChannel;
  recipientRef: string; // opaque pointer (user id / hashed contact), never raw PII
  templateKey: string;
  entityType?: string;
  entityId?: string;
}

// Structural boundary check: reject anything that looks like a raw contact,
// monetary amount or TIN slipping into the pointer fields.
function assertPointerOnly(value: string, field: string): void {
  if (/@/.test(value)) {
    throw new DomainError(
      "DATA_BOUNDARY",
      `${field} must be an opaque reference, not a raw contact`,
      400,
    );
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 8) {
    throw new DomainError(
      "DATA_BOUNDARY",
      `${field} must not embed phone numbers, amounts or TINs`,
      400,
    );
  }
}

function simulateProviderSend(channel: MessageChannel): {
  ok: boolean;
  providerMessageId?: string;
} {
  // Simulated provider: every send succeeds. A real provider integration
  // would report failures here, which the failover loop below handles.
  return { ok: true, providerMessageId: `prov_${channel}_${Date.now()}` };
}

export async function sendMessage(input: SendInput): Promise<Message> {
  const template = TEMPLATES[input.templateKey];
  if (!template) {
    throw new DomainError("UNKNOWN_TEMPLATE", "No such message template", 400);
  }
  if (!template.channels.includes(input.channel)) {
    throw new DomainError(
      "CHANNEL_NOT_ALLOWED",
      `Template ${template.key} cannot use ${input.channel}`,
      400,
    );
  }
  assertPointerOnly(input.recipientRef, "recipientRef");
  if (input.entityId) assertPointerOnly(input.entityId, "entityId");

  let channel: MessageChannel | null = input.channel;
  let failoverFrom: MessageChannel | null = null;

  while (channel) {
    if (!template.channels.includes(channel)) break;
    const send = simulateProviderSend(channel);
    if (send.ok) {
      const [row] = await getDb()
        .insert(messagesTable)
        .values({
          channel,
          recipientRef: input.recipientRef,
          templateKey: input.templateKey,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          status: "sent",
          providerMessageId: send.providerMessageId,
          failoverFrom,
        })
        .returning();
      return row;
    }
    failoverFrom = channel;
    channel = FAILOVER[channel];
  }

  const [row] = await getDb()
    .insert(messagesTable)
    .values({
      channel: input.channel,
      recipientRef: input.recipientRef,
      templateKey: input.templateKey,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      status: "failed",
      error: "all channels failed",
      failoverFrom,
    })
    .returning();
  return row;
}

// Provider webhook: advance delivery status (queued/sent -> delivered/failed).
export async function markDelivery(
  messageId: string,
  delivered: boolean,
): Promise<void> {
  await getDb()
    .update(messagesTable)
    .set({ status: delivered ? "delivered" : "failed" })
    .where(eq(messagesTable.id, messageId));
}
