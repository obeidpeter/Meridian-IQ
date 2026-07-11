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

// One ticket per notification, in the same order as the request (Expo's
// contract). `error` carries Expo's machine-readable code from
// details.error — "DeviceNotRegistered" means the token is dead and its
// push_devices row must be pruned.
export interface PushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  error?: string;
}

// Transport is injectable so tests never touch the network.
export type PushTransport = (
  notifications: PushNotification[],
) => Promise<{ ok: boolean; detail?: string; tickets?: PushTicket[] }>;

// Receipt lookup keyed by ticket id. Best-effort: receipts may not be
// available yet (Expo materialises them asynchronously); absent ids are
// simply not in the map.
export type PushReceiptTransport = (
  ticketIds: string[],
) => Promise<Record<string, { status: string; error?: string }>>;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

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
    data?: {
      status?: string;
      id?: string;
      message?: string;
      details?: { error?: string };
    }[];
  } | null;
  const rawTickets = payload?.data ?? [];
  const tickets: PushTicket[] = rawTickets.map((t) => ({
    status: t.status === "ok" ? "ok" : "error",
    id: t.id,
    message: t.message,
    error: t.details?.error,
  }));
  const okCount = tickets.filter((t) => t.status === "ok").length;
  if (tickets.length > 0 && okCount === 0) {
    return {
      ok: false,
      detail: rawTickets[0]?.message ?? "All push tickets were rejected",
      tickets,
    };
  }
  return { ok: true, tickets };
};

const expoReceiptTransport: PushReceiptTransport = async (ticketIds) => {
  const resp = await fetch(EXPO_RECEIPTS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ ids: ticketIds }),
  });
  if (!resp.ok) return {};
  const payload = (await resp.json().catch(() => null)) as {
    data?: Record<
      string,
      { status?: string; details?: { error?: string } }
    >;
  } | null;
  const receipts: Record<string, { status: string; error?: string }> = {};
  for (const [id, r] of Object.entries(payload?.data ?? {})) {
    receipts[id] = { status: r.status ?? "error", error: r.details?.error };
  }
  return receipts;
};

let transport: PushTransport = expoTransport;
let receiptTransport: PushReceiptTransport = expoReceiptTransport;

export function setPushTransport(t: PushTransport): void {
  transport = t;
}

export function resetPushTransport(): void {
  transport = expoTransport;
}

export function setPushReceiptTransport(t: PushReceiptTransport): void {
  receiptTransport = t;
}

export function resetPushReceiptTransport(): void {
  receiptTransport = expoReceiptTransport;
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
  let tickets: PushTicket[] = [];
  try {
    const result = await transport(
      devices.map((d) => ({ to: d.expoPushToken, ...copy })),
    );
    ok = result.ok;
    detail = result.detail ?? null;
    tickets = result.tickets ?? [];
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : "Push transport failed";
  }

  // Prune tokens Expo reports as dead (uninstalled app / expired token), so
  // future fan-outs skip them instead of accumulating failed ledger rows.
  // Ticket order mirrors the notifications array, so tickets[i] belongs to
  // devices[i]. Receipts are checked best-effort right after the send; any
  // DeviceNotRegistered surfaced there is pruned too. Pruning failures never
  // fail the send itself.
  try {
    const deadTokens = new Set<string>();
    const ticketIdToToken = new Map<string, string>();
    tickets.forEach((ticket, i) => {
      const token = devices[i]?.expoPushToken;
      if (!token) return;
      if (ticket.status === "error" && ticket.error === "DeviceNotRegistered") {
        deadTokens.add(token);
      } else if (ticket.status === "ok" && ticket.id) {
        ticketIdToToken.set(ticket.id, token);
      }
    });
    if (ticketIdToToken.size > 0) {
      const receipts = await receiptTransport([...ticketIdToToken.keys()]);
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.error === "DeviceNotRegistered") {
          const token = ticketIdToToken.get(id);
          if (token) deadTokens.add(token);
        }
      }
    }
    if (deadTokens.size > 0) {
      await getDb()
        .delete(pushDevicesTable)
        .where(inArray(pushDevicesTable.expoPushToken, [...deadTokens]));
    }
  } catch {
    // Best-effort cleanup; the next send retries it.
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
