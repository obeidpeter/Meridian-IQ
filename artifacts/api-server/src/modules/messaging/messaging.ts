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
  // Compliance-round delivery: a client's monthly compliance pack is ready.
  // Pointer only (SEC-12): the message names no month, amounts or counts —
  // the client opens the app to pull the pack itself.
  compliance_pack_ready: {
    key: "compliance_pack_ready",
    channels: ["whatsapp", "sms", "email", "push"],
    description: "Monthly compliance pack is ready",
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
  // Operator nudge from the platform health watch (desk/health-watch.ts).
  // Pointer only (SEC-12): the message names no rails, firms or event ids —
  // the operator opens the Desk to read the durable audit alert itself.
  platform_health: {
    key: "platform_health",
    channels: ["email", "push"],
    description: "A platform health alert for the Compliance Desk.",
  },
  // Standing-approval tripwire (round 29): the policy sweep paused an
  // automation and a human must look before it runs again. Pointer only
  // (SEC-12): no kind, reason, client or counts — the grantor opens their
  // dashboard, where the Automation strip carries the why. Full channel set:
  // a client-granted policy notifies through the party alert rails
  // (WhatsApp-first market), a staff-granted one through the staff channels.
  automation_paused: {
    key: "automation_paused",
    channels: ["whatsapp", "sms", "email", "push"],
    description: "A Clerk automation was paused and needs attention.",
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
  // The REAL recipient identity for the ledger row (exactly one per rail):
  // party-scoped alert rails set recipientPartyId, staff-notification rails
  // set recipientUserId. The notification inbox reads STRICTLY by these
  // columns — the lossy letters-only recipientRef stays for display and
  // provider-side correlation only, never as an isolation wall.
  recipientUserId?: string;
  recipientPartyId?: string;
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

// ---------------------------------------------------------------------------
// Transport seam (mirrors push.ts's PushTransport): every delivery attempt
// flows through ONE injectable function, so tests and future providers swap
// the transport without touching the failover walk or the row semantics.
//
// DATA BOUNDARY (SEC-12): the recipientRef and entityRef a transport receives
// are POINTERS, never addresses — assertPointerOnly has already rejected
// anything that looks like an email, phone number, amount or TIN. The
// receiving relay (or provider integration) owns ref → address resolution on
// ITS side of the wire; the platform never hands a raw contact to this seam.
// ---------------------------------------------------------------------------

export interface MessageTransportResult {
  ok: boolean;
  providerMessageId?: string;
  error?: string;
}

export type MessageTransport = (
  channel: MessageChannel,
  recipientRef: string,
  templateKey: string,
  entityRef: string | null,
) => Promise<MessageTransportResult>;

// Simulated provider: every send succeeds. A real provider integration
// reports failures instead, which the failover loop below handles.
const simulatorTransport: MessageTransport = async (channel) => ({
  ok: true,
  providerMessageId: `prov_${channel}_${Date.now()}`,
});

// Default transport, DARK by default: with no MESSAGING_WEBHOOK_URL
// configured every send stays in-process on the simulator — exactly the
// historical behaviour. Setting the env var lights a generic JSON webhook
// relay: the pointer-only payload {channel, recipientRef, templateKey,
// entityRef} is POSTed to the URL (x-op-token carries
// MESSAGING_WEBHOOK_TOKEN when set — same shared-secret shape as the
// operational endpoints), and the relay resolves refs to real addresses and
// talks to the actual SMTP/SMS/WhatsApp provider. An SMTP or WhatsApp BSP
// integration later is just another MessageTransport. Env is read per call
// so tests and operators can flip it without a restart.
// Hard ceiling on any relay round-trip: sends run inside sweeps and request
// handlers, and a relay that accepts the TCP connection but never answers
// would otherwise pin the caller indefinitely (fetch has no default timeout).
// An abort surfaces as the ordinary channel-failure path (failover walk /
// absorbed error) — never a hang.
const RELAY_TIMEOUT_MS = 5_000;

// Env is read per call so tests and operators can flip the relay without a
// restart. Exported for the one flow that must know whether ANY outbound
// path exists before generating state (routes/staff.ts email verification —
// a dark relay must store no code so the endpoint is not a config oracle).
export function relayConfigured(): boolean {
  return Boolean(process.env.MESSAGING_WEBHOOK_URL);
}

// The one relay POST scaffold both senders share: content-type + x-op-token
// (MESSAGING_WEBHOOK_TOKEN) headers, the shared timeout ceiling (the abort
// lands on the caller's ordinary failure path), non-2xx mapped to the
// historical error string, network errors reported never thrown. The 2xx
// Response comes back UNREAD so each caller decides whether to parse a body.
async function postToMessagingRelay(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; resp: Response } | { ok: false; error: string }> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    const token = process.env.MESSAGING_WEBHOOK_TOKEN;
    if (token) headers["x-op-token"] = token;
    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!resp.ok) {
      return { ok: false, error: `messaging webhook returned ${resp.status}` };
    }
    return { ok: true, resp };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// POST an arbitrary kind-tagged JSON payload to the configured relay (same
// URL, same x-op-token shared secret as the pointer-only transport below).
// This is the ONE home of the documented SEC-12 exception: address-carrying
// payloads (staff email verification — proving ownership of an address the
// platform has not blessed cannot ride a pointer) cross to the SAME relay
// endpoint the platform already trusts as its address-handling boundary, and
// to nowhere else. Failures are reported, never thrown — callers decide
// whether to absorb them (the verification flow does, to stay oracle-free).
export async function sendRawToRelay(
  kind: string,
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  const url = process.env.MESSAGING_WEBHOOK_URL;
  if (!url) return { ok: false, error: "relay not configured" };
  const posted = await postToMessagingRelay(url, { kind, ...payload });
  return posted.ok ? { ok: true } : posted;
}

const defaultTransport: MessageTransport = async (
  channel,
  recipientRef,
  templateKey,
  entityRef,
) => {
  const url = process.env.MESSAGING_WEBHOOK_URL;
  if (!url) {
    return simulatorTransport(channel, recipientRef, templateKey, entityRef);
  }
  const posted = await postToMessagingRelay(url, {
    channel,
    recipientRef,
    templateKey,
    entityRef,
  });
  if (!posted.ok) return posted;
  const payload = (await posted.resp.json().catch(() => null)) as {
    providerMessageId?: string;
  } | null;
  return {
    ok: true,
    providerMessageId:
      typeof payload?.providerMessageId === "string"
        ? payload.providerMessageId
        : undefined,
  };
};

let transport: MessageTransport = defaultTransport;

export function setMessageTransport(t: MessageTransport): void {
  transport = t;
}

export function resetMessageTransport(): void {
  transport = defaultTransport;
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
    // A channel the template does not permit is SKIPPED, not terminal: the
    // walk advances down the chain without attempting it (invoice_stamped
    // has no sms, but a whatsapp failure must still reach email).
    if (!template.channels.includes(channel)) {
      channel = FAILOVER[channel];
      continue;
    }
    // A transport that throws is treated exactly like one that reports
    // failure: the failover walk continues (a real webhook can reject in
    // ways its own error handling misses).
    let send: MessageTransportResult;
    try {
      send = await transport(
        channel,
        input.recipientRef,
        input.templateKey,
        input.entityId ?? null,
      );
    } catch (err) {
      send = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (send.ok) {
      const [row] = await getDb()
        .insert(messagesTable)
        .values({
          channel,
          recipientRef: input.recipientRef,
          recipientUserId: input.recipientUserId ?? null,
          recipientPartyId: input.recipientPartyId ?? null,
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
      recipientUserId: input.recipientUserId ?? null,
      recipientPartyId: input.recipientPartyId ?? null,
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
