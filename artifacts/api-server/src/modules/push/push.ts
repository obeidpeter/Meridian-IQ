import { and, eq, inArray, isNull, lte, or, type SQL } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  membershipsTable,
  messagesTable,
  pushDevicesTable,
  pushTicketsTable,
} from "@workspace/db";
import { recipientRefFor } from "../messaging/recipient-ref";

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
  // Pointer-only routing hint (PL-04/SEC-12): the template key alone — never
  // amounts, names, TINs or client details — so the app can open the right
  // screen when the notification is tapped.
  data: { template: PushTemplateKey };
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
      devices.map((d) => ({
        to: d.expoPushToken,
        ...copy,
        data: { template: opts.templateKey },
      })),
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
  // DeviceNotRegistered surfaced there is pruned too. Expo materialises
  // receipts asynchronously (often ~15 minutes later), so tickets whose
  // receipt is not available yet are persisted to push_tickets and re-checked
  // by the periodic sweep below — a death only visible in a late receipt is
  // still caught. Pruning failures never fail the send itself.
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
      // Persist pending tickets FIRST so a receipt-transport failure below
      // cannot lose them; the sweep deletes whatever the immediate check
      // resolves here (or resolves them itself later).
      await getDb()
        .insert(pushTicketsTable)
        .values(
          [...ticketIdToToken].map(([ticketId, expoPushToken]) => ({
            ticketId,
            expoPushToken,
          })),
        )
        .onConflictDoNothing({ target: pushTicketsTable.ticketId });
      const receipts = await receiptTransport([...ticketIdToToken.keys()]);
      const resolvedIds = Object.keys(receipts).filter((id) =>
        ticketIdToToken.has(id),
      );
      for (const id of resolvedIds) {
        if (receipts[id]?.error === "DeviceNotRegistered") {
          const token = ticketIdToToken.get(id);
          if (token) deadTokens.add(token);
        }
      }
      // A receipt that already materialised (any status) is final; drop its
      // pending row so the sweep does not re-check it.
      if (resolvedIds.length > 0) {
        await getDb()
          .delete(pushTicketsTable)
          .where(inArray(pushTicketsTable.ticketId, resolvedIds));
      }
    }
    if (deadTokens.size > 0) {
      await getDb()
        .delete(pushDevicesTable)
        .where(inArray(pushDevicesTable.expoPushToken, [...deadTokens]));
    }
  } catch {
    // Best-effort cleanup; the sweep (or the next send) retries it.
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

// Expo receipts typically materialise ~15 minutes after the send; only tickets
// at least this old are worth re-checking.
const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;
// Expo keeps receipts for about a day; a pending ticket older than this will
// never resolve, so drop it unconditionally to keep the table bounded.
const TICKET_EXPIRY_MS = 24 * 60 * 60 * 1000;
// Expo's getReceipts endpoint accepts up to 1000 ids; stay well under it.
const RECEIPT_BATCH_SIZE = 300;

// Periodic straggler sweep (SME-05/08 hygiene): re-check receipts for tickets
// older than the receipt delay and prune push_devices rows whose receipts
// report DeviceNotRegistered — catching deaths that were not yet visible in
// the immediate post-send check. Every ticket whose receipt materialised (any
// status) is deleted, and tickets past the expiry are dropped even without a
// receipt, so push_tickets never grows unbounded. Runs in a bypass context:
// it is a background worker with no request principal (same as its sibling
// sweeps). Returns the number of dead tokens pruned.
export async function sweepPushReceipts(
  olderThanMs = RECEIPT_CHECK_DELAY_MS,
): Promise<number> {
  return runInBypassContext(async () => {
    // Expired tickets first: their receipts are gone on Expo's side, so no
    // check can ever resolve them.
    await getDb()
      .delete(pushTicketsTable)
      .where(
        lte(
          pushTicketsTable.createdAt,
          new Date(Date.now() - TICKET_EXPIRY_MS),
        ),
      );

    const due = await getDb()
      .select({
        ticketId: pushTicketsTable.ticketId,
        expoPushToken: pushTicketsTable.expoPushToken,
      })
      .from(pushTicketsTable)
      .where(
        lte(pushTicketsTable.createdAt, new Date(Date.now() - olderThanMs)),
      );
    if (due.length === 0) return 0;

    let pruned = 0;
    for (let i = 0; i < due.length; i += RECEIPT_BATCH_SIZE) {
      const batch = due.slice(i, i + RECEIPT_BATCH_SIZE);
      const tokenByTicket = new Map(
        batch.map((t) => [t.ticketId, t.expoPushToken]),
      );
      // A transport failure throws out of the sweep (logged by the worker
      // loop); unprocessed tickets stay pending and are retried next pass.
      const receipts = await receiptTransport([...tokenByTicket.keys()]);
      const resolvedIds = Object.keys(receipts).filter((id) =>
        tokenByTicket.has(id),
      );
      const deadTokens = new Set<string>();
      for (const id of resolvedIds) {
        if (receipts[id]?.error === "DeviceNotRegistered") {
          const token = tokenByTicket.get(id);
          if (token) deadTokens.add(token);
        }
      }
      if (deadTokens.size > 0) {
        const deleted = await getDb()
          .delete(pushDevicesTable)
          .where(inArray(pushDevicesTable.expoPushToken, [...deadTokens]))
          .returning({ id: pushDevicesTable.id });
        pruned += deleted.length;
      }
      // Materialised receipts are final regardless of status; drop their
      // pending rows. Tickets with no receipt yet stay for the next pass.
      if (resolvedIds.length > 0) {
        await getDb()
          .delete(pushTicketsTable)
          .where(inArray(pushTicketsTable.ticketId, resolvedIds));
      }
    }
    return pruned;
  });
}
