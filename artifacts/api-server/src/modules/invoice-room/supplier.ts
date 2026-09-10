import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  confirmationsTable,
  getDb,
  invoiceRoomEventsTable,
  invoiceRoomPaymentRequestsTable,
  invoiceRoomSharesTable,
  invoicesTable,
  partiesTable,
  runRequestContext,
  type InvoiceRoomShare,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import type { Principal } from "../auth/rbac";
import {
  requireFirmScope,
  assertClientPartyScope,
  clientPartyScope,
} from "../auth/rbac";
import { normalizeEmail } from "../auth/session";
import { DomainError } from "../errors";
import { recordConfirmation } from "../invoice/confirmations";
import { sendRawToRelay } from "../messaging/messaging";
import { normalizePhone } from "../../lib/phone";
import { withProviderOperationLock } from "../../lib/provider-operation-lock";
import {
  decryptRoomToken,
  digestRoomSecret,
  encryptRoomToken,
  invoiceRoomLink,
  makeRoomSecret,
} from "./security";
import {
  SHAREABLE_STATUSES,
  shareStatus,
  maskedRecipient,
  appendRoomEvent,
} from "./core";
import type {
  CreateRoomInput,
  SupplierRoomSummary,
  RoomDelivery,
  CreatedRoom,
} from "./core";

// The supplier side of an Invoice Room (R109: split out of service.ts):
// creating, replacing, revoking and listing rooms, link delivery and the
// supplier's room summary. Firm-scoped, SEC-03-checked on every write.

function normalizedRoomInput(input: CreateRoomInput): CreateRoomInput {
  const email = input.recipientEmail
    ? normalizeEmail(input.recipientEmail)
    : null;
  const phone = input.recipientPhone
    ? normalizePhone(input.recipientPhone)
    : null;
  if (input.recipientPhone && !phone) {
    throw new DomainError(
      "INVALID_PHONE",
      "Enter a valid WhatsApp number including its country code",
      400,
    );
  }
  if (input.deliveryChannel === "email" && !email) {
    throw new DomainError(
      "RECIPIENT_REQUIRED",
      "An email address is required for email delivery",
      400,
    );
  }
  if (input.deliveryChannel === "whatsapp" && !phone) {
    throw new DomainError(
      "RECIPIENT_REQUIRED",
      "A phone number is required for WhatsApp delivery",
      400,
    );
  }
  if (
    (input.sendNow || input.remindersEnabled) &&
    input.deliveryChannel !== "copy" &&
    !input.contactConsent
  ) {
    throw new DomainError(
      "CONTACT_CONSENT_REQUIRED",
      "Confirm that the buyer agreed to receive this invoice link",
      400,
    );
  }
  if (input.remindersEnabled && input.deliveryChannel === "copy") {
    throw new DomainError(
      "REMINDER_CHANNEL_REQUIRED",
      "Choose email or WhatsApp before enabling reminders",
      400,
    );
  }
  return { ...input, recipientEmail: email, recipientPhone: phone };
}

async function summaryForShare(
  share: InvoiceRoomShare,
): Promise<SupplierRoomSummary> {
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, share.invoiceId))
    .limit(1);
  if (!invoice) throw new DomainError("NOT_FOUND", "Invoice not found", 404);
  const [buyer] = await getDb()
    .select({ legalName: partiesTable.legalName })
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.buyerPartyId))
    .limit(1);
  const [events, confirmations, payments] = await Promise.all([
    getDb()
      .select({
        kind: invoiceRoomEventsTable.kind,
        createdAt: invoiceRoomEventsTable.createdAt,
      })
      .from(invoiceRoomEventsTable)
      .where(eq(invoiceRoomEventsTable.shareId, share.id))
      .orderBy(desc(invoiceRoomEventsTable.createdAt)),
    getDb()
      .select({ state: confirmationsTable.state })
      .from(confirmationsTable)
      .where(eq(confirmationsTable.invoiceId, invoice.id))
      .orderBy(desc(confirmationsTable.createdAt))
      .limit(1),
    getDb()
      .select({ status: invoiceRoomPaymentRequestsTable.status })
      .from(invoiceRoomPaymentRequestsTable)
      .where(eq(invoiceRoomPaymentRequestsTable.shareId, share.id))
      .orderBy(desc(invoiceRoomPaymentRequestsTable.createdAt))
      .limit(1),
  ]);
  return {
    id: share.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    buyerName: buyer?.legalName ?? "Buyer",
    amount: invoice.grandTotal,
    currency: invoice.currency,
    invoiceStatus: invoice.status,
    status: shareStatus(share),
    deliveryChannel: share.deliveryChannel,
    recipient: maskedRecipient(share),
    remindersEnabled: share.remindersEnabled,
    expiresAt: share.expiresAt.toISOString(),
    createdAt: share.createdAt.toISOString(),
    lastDeliveredAt: share.lastDeliveredAt?.toISOString() ?? null,
    lastActivityAt: events[0]?.createdAt.toISOString() ?? null,
    openedAt:
      events
        .find((event) => event.kind === "opened")
        ?.createdAt.toISOString() ?? null,
    verifiedAt:
      events
        .find((event) => event.kind === "identity_verified")
        ?.createdAt.toISOString() ?? null,
    responseState: confirmations[0]?.state ?? null,
    paymentStatus:
      invoice.status === "settled"
        ? "confirmed"
        : (payments[0]?.status ?? null),
  };
}

async function deliverShare(
  share: InvoiceRoomShare,
  token: string,
  sendNow: boolean,
): Promise<RoomDelivery> {
  if (!sendNow || share.deliveryChannel === "copy") {
    return { attempted: false, status: "not_requested" };
  }
  const to =
    share.deliveryChannel === "email"
      ? share.recipientEmail
      : share.recipientPhone;
  if (!to) return { attempted: false, status: "not_requested" };
  const delivery = await sendRawToRelay(
    "invoice_room_share",
    {
      channel: share.deliveryChannel,
      to,
      link: invoiceRoomLink(token),
      expiresAt: share.expiresAt.toISOString(),
    },
    {
      idempotencyKey: `invoice-room-share:${share.id}`,
    },
  );
  await runRequestContext({ bypass: false, firmId: share.firmId }, async () => {
    if (delivery.ok) {
      await getDb()
        .update(invoiceRoomSharesTable)
        .set({ lastDeliveredAt: new Date(), updatedAt: new Date() })
        .where(eq(invoiceRoomSharesTable.id, share.id));
    }
    await appendRoomEvent({
      share,
      kind: delivery.ok ? "delivery_sent" : "delivery_failed",
      actorType: "system",
      detail: { channel: share.deliveryChannel },
      idempotencyKey: "delivery:initial",
    });
  });
  return delivery.ok
    ? { attempted: true, status: "sent" }
    : {
        attempted: true,
        status: "failed",
        error: "Delivery failed; copy the secure link instead.",
      };
}

async function reserveRoom(
  principal: Principal,
  invoiceId: string,
  rawInput: CreateRoomInput,
  replaceShareId?: string,
): Promise<{ share: InvoiceRoomShare; token: string }> {
  const firmId = requireFirmScope(principal);
  const input = normalizedRoomInput(rawInput);
  return runRequestContext({ bypass: false, firmId }, async () => {
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    if (!invoice || invoice.firmId !== firmId) {
      throw new DomainError("NOT_FOUND", "Invoice not found", 404);
    }
    // SEC-03: the shared helper, not an inline role check (R105 review).
    assertClientPartyScope(principal, invoice.supplierPartyId);
    if (
      !SHAREABLE_STATUSES.includes(
        invoice.status as (typeof SHAREABLE_STATUSES)[number],
      )
    ) {
      throw new DomainError(
        "INVOICE_NOT_SHAREABLE",
        `Invoice is ${invoice.status}; submit and stamp it before opening an Invoice Room`,
        409,
      );
    }

    const [replayed] = await getDb()
      .select()
      .from(invoiceRoomSharesTable)
      .where(
        and(
          eq(invoiceRoomSharesTable.firmId, firmId),
          eq(invoiceRoomSharesTable.clientRequestId, input.clientRequestId),
        ),
      )
      .limit(1);
    if (replayed) {
      if (replayed.invoiceId !== invoiceId) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "That request identifier was already used for another invoice",
          409,
        );
      }
      return {
        share: replayed,
        token: decryptRoomToken(replayed.tokenCiphertext),
      };
    }

    if (replaceShareId) {
      const [replaced] = await getDb()
        .update(invoiceRoomSharesTable)
        .set({ revokedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(invoiceRoomSharesTable.id, replaceShareId),
            eq(invoiceRoomSharesTable.invoiceId, invoiceId),
            isNull(invoiceRoomSharesTable.revokedAt),
          ),
        )
        .returning();
      if (!replaced) {
        throw new DomainError(
          "ROOM_NOT_ACTIVE",
          "Invoice Room is no longer active",
          409,
        );
      }
      await appendRoomEvent({
        share: replaced,
        kind: "revoked",
        actorType: "supplier",
        actorRef: principal.userId,
        detail: { reason: "replaced" },
        idempotencyKey: `replace:${input.clientRequestId}`,
      });
    } else {
      const [live] = await getDb()
        .select({ id: invoiceRoomSharesTable.id })
        .from(invoiceRoomSharesTable)
        .where(
          and(
            eq(invoiceRoomSharesTable.invoiceId, invoiceId),
            isNull(invoiceRoomSharesTable.revokedAt),
          ),
        )
        .limit(1);
      if (live) {
        throw new DomainError(
          "INVOICE_ROOM_EXISTS",
          "This invoice already has an active room. Replace it to issue a new link.",
          409,
        );
      }
    }

    const token = makeRoomSecret();
    const [share] = await getDb()
      .insert(invoiceRoomSharesTable)
      .values({
        firmId,
        invoiceId,
        tokenHash: digestRoomSecret(token),
        tokenCiphertext: encryptRoomToken(token),
        clientRequestId: input.clientRequestId,
        recipientEmail: input.recipientEmail ?? null,
        recipientPhone: input.recipientPhone ?? null,
        deliveryChannel: input.deliveryChannel,
        remindersEnabled: input.remindersEnabled,
        contactConsentAt: input.contactConsent ? new Date() : null,
        expiresAt: new Date(
          Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
        ),
        createdByUserId: principal.userId,
      })
      .returning();
    await appendRoomEvent({
      share,
      kind: "created",
      actorType: "supplier",
      actorRef: principal.userId,
      detail: {
        channel: share.deliveryChannel,
        remindersEnabled: share.remindersEnabled,
      },
      idempotencyKey: "created",
    });

    // A stamped room is actionable immediately. Reuse the canonical
    // confirmation state machine so the room and Buyer Rails share lineage.
    if (invoice.status === "stamped") {
      const [latest] = await getDb()
        .select({ state: confirmationsTable.state })
        .from(confirmationsTable)
        .where(eq(confirmationsTable.invoiceId, invoice.id))
        .orderBy(desc(confirmationsTable.createdAt))
        .limit(1);
      if (
        !latest ||
        latest.state === "queried" ||
        latest.state === "rejected"
      ) {
        await recordConfirmation(
          invoice,
          { buyerPartyId: invoice.buyerPartyId, state: "requested" },
          principal,
        );
      }
    }
    await appendAudit({
      actorId: principal.userId,
      actorRole: principal.role,
      firmId,
      action: "invoice_room.created",
      entityType: "invoice_room",
      entityId: share.id,
      after: { invoiceId, channel: share.deliveryChannel },
    });
    return { share, token };
  });
}

export async function createInvoiceRoom(
  principal: Principal,
  invoiceId: string,
  input: CreateRoomInput,
): Promise<CreatedRoom> {
  const firmId = requireFirmScope(principal);
  return withProviderOperationLock(
    `invoice-room:${firmId}:${invoiceId}`,
    async () => {
      const reserved = await reserveRoom(principal, invoiceId, input);
      const delivery = await deliverShare(
        reserved.share,
        reserved.token,
        input.sendNow,
      );
      const room = await runRequestContext({ bypass: false, firmId }, () =>
        summaryForShare(reserved.share),
      );
      return { room, url: invoiceRoomLink(reserved.token), delivery };
    },
  );
}

export async function replaceInvoiceRoom(
  principal: Principal,
  shareId: string,
  input: CreateRoomInput,
): Promise<CreatedRoom> {
  const firmId = requireFirmScope(principal);
  return withProviderOperationLock(
    `invoice-room-replace:${firmId}:${shareId}`,
    async () => {
      const current = await runRequestContext(
        { bypass: false, firmId },
        async () => {
          const [row] = await getDb()
            .select()
            .from(invoiceRoomSharesTable)
            .where(eq(invoiceRoomSharesTable.id, shareId))
            .limit(1);
          if (!row)
            throw new DomainError("NOT_FOUND", "Invoice Room not found", 404);
          return row;
        },
      );
      const reserved = await reserveRoom(
        principal,
        current.invoiceId,
        input,
        shareId,
      );
      const delivery = await deliverShare(
        reserved.share,
        reserved.token,
        input.sendNow,
      );
      const room = await runRequestContext({ bypass: false, firmId }, () =>
        summaryForShare(reserved.share),
      );
      return { room, url: invoiceRoomLink(reserved.token), delivery };
    },
  );
}

export async function revokeInvoiceRoom(
  principal: Principal,
  shareId: string,
): Promise<SupplierRoomSummary> {
  const firmId = requireFirmScope(principal);
  return runRequestContext({ bypass: false, firmId }, async () => {
    const [existing] = await getDb()
      .select()
      .from(invoiceRoomSharesTable)
      .where(eq(invoiceRoomSharesTable.id, shareId))
      .limit(1);
    if (!existing)
      throw new DomainError("NOT_FOUND", "Invoice Room not found", 404);
    const [invoice] = await getDb()
      .select({ supplierPartyId: invoicesTable.supplierPartyId })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, existing.invoiceId))
      .limit(1);
    if (
      !invoice ||
      (principal.role === "client_user" &&
        principal.clientPartyId !== invoice.supplierPartyId)
    ) {
      throw new DomainError("NOT_FOUND", "Invoice Room not found", 404);
    }
    const [revoked] = await getDb()
      .update(invoiceRoomSharesTable)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(invoiceRoomSharesTable.id, shareId),
          isNull(invoiceRoomSharesTable.revokedAt),
        ),
      )
      .returning();
    const row = revoked ?? existing;
    if (revoked) {
      await appendRoomEvent({
        share: row,
        kind: "revoked",
        actorType: "supplier",
        actorRef: principal.userId,
        idempotencyKey: "revoked",
      });
      await appendAudit({
        actorId: principal.userId,
        actorRole: principal.role,
        firmId,
        action: "invoice_room.revoked",
        entityType: "invoice_room",
        entityId: row.id,
      });
    }
    return summaryForShare(row);
  });
}

export async function listInvoiceRooms(
  principal: Principal,
  invoiceId?: string,
): Promise<SupplierRoomSummary[]> {
  const firmId = requireFirmScope(principal);
  const scopes = [eq(invoiceRoomSharesTable.firmId, firmId)];
  const partyScope = clientPartyScope(principal);
  if (principal.role === "client_user") {
    if (!partyScope) return [];
    scopes.push(eq(invoicesTable.supplierPartyId, partyScope));
  }
  if (invoiceId) scopes.push(eq(invoiceRoomSharesTable.invoiceId, invoiceId));
  const rows = await getDb()
    .select({
      share: invoiceRoomSharesTable,
      invoiceNumber: invoicesTable.invoiceNumber,
      amount: invoicesTable.grandTotal,
      currency: invoicesTable.currency,
      invoiceStatus: invoicesTable.status,
      buyerName: partiesTable.legalName,
      lastActivityAt: sql<Date | null>`(
        SELECT max(event.created_at)
          FROM invoice_room_events event
         WHERE event.share_id = ${invoiceRoomSharesTable.id}
      )`,
      openedAt: sql<Date | null>`(
        SELECT max(event.created_at)
          FROM invoice_room_events event
         WHERE event.share_id = ${invoiceRoomSharesTable.id}
           AND event.kind = 'opened'
      )`,
      verifiedAt: sql<Date | null>`(
        SELECT max(event.created_at)
          FROM invoice_room_events event
         WHERE event.share_id = ${invoiceRoomSharesTable.id}
           AND event.kind = 'identity_verified'
      )`,
      responseState: sql<string | null>`(
        SELECT confirmation.state::text
          FROM confirmations confirmation
         WHERE confirmation.invoice_id = ${invoicesTable.id}
         ORDER BY confirmation.created_at DESC
         LIMIT 1
      )`,
      latestPaymentStatus: sql<string | null>`(
        SELECT payment.status::text
          FROM invoice_room_payment_requests payment
         WHERE payment.share_id = ${invoiceRoomSharesTable.id}
         ORDER BY payment.created_at DESC
         LIMIT 1
      )`,
    })
    .from(invoiceRoomSharesTable)
    .innerJoin(
      invoicesTable,
      eq(invoicesTable.id, invoiceRoomSharesTable.invoiceId),
    )
    .innerJoin(partiesTable, eq(partiesTable.id, invoicesTable.buyerPartyId))
    .where(and(...scopes))
    .orderBy(desc(invoiceRoomSharesTable.createdAt))
    .limit(500);
  return rows.map((row) => ({
    id: row.share.id,
    invoiceId: row.share.invoiceId,
    invoiceNumber: row.invoiceNumber,
    buyerName: row.buyerName,
    amount: row.amount,
    currency: row.currency,
    invoiceStatus: row.invoiceStatus,
    status: shareStatus(row.share),
    deliveryChannel: row.share.deliveryChannel,
    recipient: maskedRecipient(row.share),
    remindersEnabled: row.share.remindersEnabled,
    expiresAt: row.share.expiresAt.toISOString(),
    createdAt: row.share.createdAt.toISOString(),
    lastDeliveredAt: row.share.lastDeliveredAt?.toISOString() ?? null,
    lastActivityAt: row.lastActivityAt?.toISOString() ?? null,
    openedAt: row.openedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    responseState: row.responseState,
    paymentStatus:
      row.invoiceStatus === "settled" ? "confirmed" : row.latestPaymentStatus,
  }));
}
