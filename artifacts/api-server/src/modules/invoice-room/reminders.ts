import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  getDb,
  invoiceRoomSessionsTable,
  invoiceRoomSharesTable,
  invoicesTable,
  runInBypassContext,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { sendRawToRelay } from "../messaging/messaging";
import { decryptRoomToken, invoiceRoomLink } from "./security";
import { appendRoomEvent } from "./core";

// The Invoice Room reminder sweep (R109: split out of service.ts): due-soon
// and overdue reminders for consenting recipients, skipping firms whose
// invoice_room flag is dark.

export async function sweepInvoiceRoomReminders(
  now = new Date(),
): Promise<number> {
  return runInBypassContext(async () => {
    await getDb()
      .delete(invoiceRoomSessionsTable)
      .where(
        lt(
          invoiceRoomSessionsTable.expiresAt,
          new Date(now.getTime() - 24 * 60 * 60 * 1000),
        ),
      );
    const candidates = await getDb()
      .select({ share: invoiceRoomSharesTable, invoice: invoicesTable })
      .from(invoiceRoomSharesTable)
      .innerJoin(
        invoicesTable,
        eq(invoicesTable.id, invoiceRoomSharesTable.invoiceId),
      )
      .where(
        and(
          isNull(invoiceRoomSharesTable.revokedAt),
          eq(invoiceRoomSharesTable.remindersEnabled, true),
          sql`${invoiceRoomSharesTable.contactConsentAt} IS NOT NULL`,
          sql`${invoiceRoomSharesTable.expiresAt} > ${now}`,
          inArray(invoicesTable.status, ["stamped", "confirmed"]),
          sql`${invoicesTable.dueDate} IS NOT NULL`,
          sql`${invoicesTable.dueDate}::date <= (${now}::timestamptz AT TIME ZONE 'Africa/Lagos')::date + 3`,
        ),
      )
      .orderBy(invoicesTable.dueDate)
      .limit(100);
    let claimed = 0;
    // A firm whose invoice_room flag was darkened (an incident kill switch)
    // must not keep receiving reminder links that 404 on open (R105 review).
    const lit = new Map<string, boolean>();
    for (const { share, invoice } of candidates) {
      if (!lit.has(share.firmId))
        lit.set(
          share.firmId,
          await isFeatureEnabled("invoice_room", share.firmId),
        );
      if (!lit.get(share.firmId)) continue;
      const due = new Date(`${invoice.dueDate}T23:59:59+01:00`);
      const kind = due.getTime() < now.getTime() ? "overdue" : "due_soon";
      const claim = await appendRoomEvent({
        share,
        kind: "reminder_reserved",
        actorType: "system",
        detail: { kind },
        idempotencyKey: `reminder:${kind}`,
      });
      if (!claim.created) continue;
      claimed++;
      const target =
        share.deliveryChannel === "email"
          ? share.recipientEmail
          : share.recipientPhone;
      const token = decryptRoomToken(share.tokenCiphertext);
      const delivery = target
        ? await sendRawToRelay(
            "invoice_room_reminder",
            {
              channel: share.deliveryChannel,
              to: target,
              link: invoiceRoomLink(token),
              kind,
              dueDate: invoice.dueDate,
            },
            {
              idempotencyKey: `invoice-room-reminder:${share.id}:${kind}`,
            },
          )
        : { ok: false, error: "no recipient" };
      await appendRoomEvent({
        share,
        kind: delivery.ok ? "reminder_sent" : "reminder_failed",
        actorType: "system",
        detail: { kind, channel: share.deliveryChannel },
        idempotencyKey: `reminder-result:${kind}`,
      });
      if (delivery.ok) {
        await getDb()
          .update(invoiceRoomSharesTable)
          .set({ lastDeliveredAt: now, updatedAt: now })
          .where(eq(invoiceRoomSharesTable.id, share.id));
      }
    }
    return claimed;
  });
}
