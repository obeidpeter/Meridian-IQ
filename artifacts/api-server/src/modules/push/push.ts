import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import {
  getDb,
  membershipsTable,
  messagesTable,
  pushDevicesTable,
} from "@workspace/db";

// Expo push-notification delivery for the mobile companion app (SME-05/08).
// Same strict data boundary as the messaging gateway (PL-04, SEC-12): push
// payloads are pointer-only — fixed template copy, never amounts, names, TINs
// or client details. Delivery is recorded in the messages ledger under the
// "push" channel with an opaque recipient reference.

export type PushTemplateKey = "deadline_reminder" | "b2c_window_alert";

const PUSH_COPY: Record<PushTemplateKey, { title: string; body: string }> = {
  deadline_reminder: {
    title: "MeridianIQ",
    body: "A filing or payment deadline is approaching. Open the app for details.",
  },
  b2c_window_alert: {
    title: "MeridianIQ",
    body: "A B2C reporting window is about to close. Open the app for details.",
  },
};

export interface PushSendOutcome {
  status: "sent" | "failed" | "skipped";
  messageId: string | null;
  detail: string | null;
}

export interface PushNotification {
  to: string;
  title: string;
  body: string;
}

// Transport is injectable so tests never touch the network.
export type PushTransport = (
  notifications: PushNotification[],
) => Promise<{ ok: boolean; detail?: string }>;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

const expoTransport: PushTransport = async (notifications) => {
  const resp = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(notifications),
  });
  if (!resp.ok) {
    return { ok: false, detail: `Expo push service returned ${resp.status}` };
  }
  const payload = (await resp.json().catch(() => null)) as {
    data?: { status?: string; message?: string }[];
  } | null;
  const tickets = payload?.data ?? [];
  const okCount = tickets.filter((t) => t.status === "ok").length;
  if (tickets.length > 0 && okCount === 0) {
    return {
      ok: false,
      detail: tickets[0]?.message ?? "All push tickets were rejected",
    };
  }
  return { ok: true };
};

let transport: PushTransport = expoTransport;

export function setPushTransport(t: PushTransport): void {
  transport = t;
}

export function resetPushTransport(): void {
  transport = expoTransport;
}

// Opaque, PII-free recipient reference derived from the party id (letters
// only, matching the messaging gateway's data-boundary convention).
function recipientRefFor(clientPartyId: string): string {
  const letters = clientPartyId.replace(/[^a-z]/gi, "").slice(0, 16);
  return `ref-${letters || "client"}`;
}

// Devices that should receive alerts for a client Party: devices registered by
// a principal scoped to that client, plus devices of firm staff (no client
// scope) in the client's tenant firm — staff monitor all their clients.
async function devicesForClientParty(
  clientPartyId: string,
  firmId: string | null,
): Promise<{ expoPushToken: string }[]> {
  const members = await getDb()
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .where(eq(membershipsTable.clientPartyId, clientPartyId));
  const userIds = members.map((m) => m.userId);

  const conds: SQL[] = [eq(pushDevicesTable.clientPartyId, clientPartyId)];
  if (userIds.length > 0) {
    conds.push(inArray(pushDevicesTable.userId, userIds));
  }
  if (firmId) {
    const firmCond = and(
      eq(pushDevicesTable.firmId, firmId),
      isNull(pushDevicesTable.clientPartyId),
    );
    if (firmCond) conds.push(firmCond);
  }
  return getDb()
    .select({ expoPushToken: pushDevicesTable.expoPushToken })
    .from(pushDevicesTable)
    .where(or(...conds));
}

export async function sendPushAlert(opts: {
  clientPartyId: string;
  firmId: string | null;
  templateKey: PushTemplateKey;
  entityType?: string;
  entityId?: string;
}): Promise<PushSendOutcome> {
  const devices = await devicesForClientParty(opts.clientPartyId, opts.firmId);
  if (devices.length === 0) {
    return {
      status: "skipped",
      messageId: null,
      detail: "No registered devices",
    };
  }

  const copy = PUSH_COPY[opts.templateKey];
  const recipientRef = recipientRefFor(opts.clientPartyId);
  let ok = false;
  let detail: string | null = null;
  try {
    const result = await transport(
      devices.map((d) => ({ to: d.expoPushToken, ...copy })),
    );
    ok = result.ok;
    detail = result.detail ?? null;
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : "Push transport failed";
  }

  const providerMessageId = ok ? `expo_push_${Date.now()}` : undefined;
  await getDb()
    .insert(messagesTable)
    .values({
      channel: "push",
      recipientRef,
      templateKey: opts.templateKey,
      entityType: opts.entityType ?? null,
      entityId: opts.entityId ?? null,
      status: ok ? "sent" : "failed",
      providerMessageId,
      error: ok ? null : (detail ?? "push delivery failed"),
    });

  return {
    status: ok ? "sent" : "failed",
    messageId: providerMessageId ?? null,
    detail,
  };
}
