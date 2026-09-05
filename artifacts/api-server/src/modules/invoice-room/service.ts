import { randomInt } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  collectionAccountsTable,
  confirmationsTable,
  getDb,
  invoiceLinesTable,
  invoiceRoomEventsTable,
  invoiceRoomPaymentRequestsTable,
  invoiceRoomSessionsTable,
  invoiceRoomSharesTable,
  invoicesTable,
  membershipsTable,
  partiesTable,
  runInBypassContext,
  runRequestContext,
  settlementEventsTable,
  stampRecordsTable,
  usersTable,
  type Invoice,
  type InvoiceRoomShare,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import type { Principal } from "../auth/rbac";
import { requireFirmScope,
  assertClientPartyScope,
  clientPartyScope,
} from "../auth/rbac";
import {
  hashPassword,
  issueSessionToken,
  normalizeEmail,
} from "../auth/session";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { recordConfirmation } from "../invoice/confirmations";
import { isPresentableAsEligible, tryTransition } from "../invoice/lifecycle";
import { appendSettlementEvent } from "../invoice/settlement";
import { sendRawToRelay } from "../messaging/messaging";
import { decimalToMinorUnits } from "../../lib/money";
import { normalizePhone } from "../../lib/phone";
import { resolvePaymentFlagAmount } from "../../lib/parse";
import { withProviderOperationLock } from "../../lib/provider-operation-lock";
import { initializeInvoicePayment } from "./provider";
import {
  decryptRoomToken,
  digestRoomSecret,
  encryptRoomToken,
  invoiceRoomLink,
  makeRoomSecret,
  maskEmail,
  maskPhone,
  roomOtpDigest,
  ROOM_OTP_TTL_MS,
  ROOM_SESSION_TTL_MS,
  safeDigestEqual,
} from "./security";

const SHAREABLE_STATUSES = ["stamped", "confirmed", "settled"] as const;
const ACTIONABLE_STATUSES = new Set<string>(SHAREABLE_STATUSES);
const PUBLIC_EVENT_KINDS = new Set([
  "created",
  "opened",
  "delivery_sent",
  "identity_verified",
  "confirmed",
  "queried",
  "rejected",
  "payment_reported",
  "payment_link_created",
  "payment_confirmed",
  "claimed",
  "reminder_sent",
]);

export interface CreateRoomInput {
  clientRequestId: string;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  deliveryChannel: "email" | "whatsapp" | "copy";
  expiresInDays: number;
  sendNow: boolean;
  remindersEnabled: boolean;
  contactConsent: boolean;
}

export interface SupplierRoomSummary {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  amount: string;
  currency: string;
  invoiceStatus: string;
  status: "active" | "expired" | "revoked";
  deliveryChannel: "email" | "whatsapp" | "copy";
  recipient: string | null;
  remindersEnabled: boolean;
  expiresAt: string;
  createdAt: string;
  lastDeliveredAt: string | null;
  lastActivityAt: string | null;
  openedAt: string | null;
  verifiedAt: string | null;
  responseState: string | null;
  paymentStatus: string | null;
}

export interface RoomDelivery {
  attempted: boolean;
  status: "not_requested" | "sent" | "failed";
  error?: string;
}

export interface CreatedRoom {
  room: SupplierRoomSummary;
  url: string;
  delivery: RoomDelivery;
}

export interface RoomAccess {
  session: typeof invoiceRoomSessionsTable.$inferSelect;
  share: InvoiceRoomShare;
  invoice: Invoice;
  sessionToken: string;
}

function roomActor(share: InvoiceRoomShare, invoice: Invoice): Principal {
  return {
    userId: `invoice-room:${share.id}`,
    role: "buyer_user",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: invoice.buyerPartyId,
  };
}

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

function shareStatus(
  share: Pick<InvoiceRoomShare, "revokedAt" | "expiresAt">,
): "active" | "expired" | "revoked" {
  if (share.revokedAt) return "revoked";
  return share.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}

function maskedRecipient(share: InvoiceRoomShare): string | null {
  if (share.deliveryChannel === "whatsapp")
    return maskPhone(share.recipientPhone);
  if (share.deliveryChannel === "email") return maskEmail(share.recipientEmail);
  return maskEmail(share.recipientEmail) ?? maskPhone(share.recipientPhone);
}

async function assertRoomFeature(firmId: string): Promise<void> {
  if (!(await isFeatureEnabled("invoice_room", firmId))) {
    throw new DomainError("NOT_FOUND", "Invoice Room not found", 404);
  }
}

function assertShareActive(share: InvoiceRoomShare): void {
  const status = shareStatus(share);
  if (status !== "active") {
    throw new DomainError(
      status === "revoked" ? "ROOM_REVOKED" : "ROOM_EXPIRED",
      status === "revoked"
        ? "This secure invoice link has been revoked"
        : "This secure invoice link has expired",
      410,
    );
  }
}

async function loadShareAndInvoice(shareId: string): Promise<{
  share: InvoiceRoomShare;
  invoice: Invoice;
}> {
  const [share] = await getDb()
    .select()
    .from(invoiceRoomSharesTable)
    .where(eq(invoiceRoomSharesTable.id, shareId))
    .limit(1);
  if (!share)
    throw new DomainError("ROOM_NOT_FOUND", "Invoice Room not found", 404);
  await assertRoomFeature(share.firmId);
  const [invoice] = await getDb()
    .select()
    .from(invoicesTable)
    .where(eq(invoicesTable.id, share.invoiceId))
    .limit(1);
  if (!invoice || invoice.firmId !== share.firmId) {
    throw new DomainError("ROOM_NOT_FOUND", "Invoice Room not found", 404);
  }
  return { share, invoice };
}

/** The share a buyer session belongs to — the key for per-room throttles
 *  (R105 review): a link holder can mint sessions at will, so a per-session
 *  budget alone resets on every re-exchange. */
export async function resolveRoomShareId(
  sessionToken: string | null | undefined,
): Promise<string> {
  return runInBypassContext(async () => (await loadRoomAccess(sessionToken)).share.id);
}

export async function loadRoomAccess(
  sessionToken: string | null | undefined,
  options: { requireVerified?: boolean } = {},
): Promise<RoomAccess> {
  if (!sessionToken || sessionToken.length > 256) {
    throw new DomainError(
      "ROOM_SESSION_REQUIRED",
      "Open the secure invoice link again",
      401,
    );
  }
  const [session] = await getDb()
    .select()
    .from(invoiceRoomSessionsTable)
    .where(
      eq(invoiceRoomSessionsTable.tokenHash, digestRoomSecret(sessionToken)),
    )
    .limit(1);
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    throw new DomainError(
      "ROOM_SESSION_EXPIRED",
      "Your secure session has expired. Open the invoice link again.",
      401,
    );
  }
  const { share, invoice } = await loadShareAndInvoice(session.shareId);
  assertShareActive(share);
  if (options.requireVerified && !session.verifiedAt) {
    throw new DomainError(
      "ROOM_VERIFICATION_REQUIRED",
      "Verify your email or WhatsApp number before completing this action",
      403,
    );
  }
  return { session, share, invoice, sessionToken };
}

async function appendRoomEvent(input: {
  share: InvoiceRoomShare;
  kind: typeof invoiceRoomEventsTable.$inferInsert.kind;
  actorType: typeof invoiceRoomEventsTable.$inferInsert.actorType;
  actorRef?: string | null;
  detail?: Record<string, unknown>;
  idempotencyKey?: string | null;
}): Promise<{ id: string; created: boolean }> {
  const [created] = await getDb()
    .insert(invoiceRoomEventsTable)
    .values({
      firmId: input.share.firmId,
      invoiceId: input.share.invoiceId,
      shareId: input.share.id,
      kind: input.kind,
      actorType: input.actorType,
      actorRef: input.actorRef ?? null,
      detail: input.detail ?? {},
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: invoiceRoomEventsTable.id });
  if (created) return { id: created.id, created: true };
  if (!input.idempotencyKey) {
    throw new DomainError(
      "ROOM_EVENT_CONFLICT",
      "Invoice Room activity could not be recorded",
      409,
    );
  }
  const [existing] = await getDb()
    .select({
      id: invoiceRoomEventsTable.id,
      kind: invoiceRoomEventsTable.kind,
      actorType: invoiceRoomEventsTable.actorType,
      actorRef: invoiceRoomEventsTable.actorRef,
      detail: invoiceRoomEventsTable.detail,
    })
    .from(invoiceRoomEventsTable)
    .where(
      and(
        eq(invoiceRoomEventsTable.shareId, input.share.id),
        eq(invoiceRoomEventsTable.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new DomainError(
      "ROOM_EVENT_CONFLICT",
      "Invoice Room activity could not be recorded",
      409,
    );
  }
  if (
    existing.kind !== input.kind ||
    existing.actorType !== input.actorType ||
    existing.actorRef !== (input.actorRef ?? null) ||
    !isDeepStrictEqual(existing.detail, input.detail ?? {})
  ) {
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "That idempotency key was already used for a different Invoice Room action",
      409,
    );
  }
  return { id: existing.id, created: false };
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

export async function exchangeInvoiceRoomToken(token: string): Promise<{
  sessionToken: string;
  view: Awaited<ReturnType<typeof invoiceRoomView>>;
}> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) {
    throw new DomainError(
      "ROOM_LINK_INVALID",
      "This secure invoice link is invalid",
      404,
    );
  }
  return runInBypassContext(async () => {
    const [share] = await getDb()
      .select()
      .from(invoiceRoomSharesTable)
      .where(eq(invoiceRoomSharesTable.tokenHash, digestRoomSecret(token)))
      .limit(1);
    if (!share)
      throw new DomainError(
        "ROOM_LINK_INVALID",
        "This secure invoice link is invalid",
        404,
      );
    await assertRoomFeature(share.firmId);
    assertShareActive(share);
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, share.invoiceId))
      .limit(1);
    if (!invoice)
      throw new DomainError(
        "ROOM_LINK_INVALID",
        "This secure invoice link is invalid",
        404,
      );
    const sessionToken = makeRoomSecret();
    const [session] = await getDb()
      .insert(invoiceRoomSessionsTable)
      .values({
        shareId: share.id,
        tokenHash: digestRoomSecret(sessionToken),
        expiresAt: new Date(Date.now() + ROOM_SESSION_TTL_MS),
      })
      .returning();
    await appendRoomEvent({
      share,
      kind: "opened",
      actorType: "buyer_guest",
      actorRef: digestRoomSecret(session.id).slice(0, 24),
      idempotencyKey: `opened:${session.id}`,
    });
    return {
      sessionToken,
      view: await invoiceRoomView({ session, share, invoice, sessionToken }),
    };
  });
}

export async function invoiceRoomView(access: RoomAccess) {
  const { session, share, invoice } = access;
  const [
    lines,
    parties,
    stamps,
    confirmations,
    settlements,
    accounts,
    events,
    payments,
  ] = await Promise.all([
    getDb()
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, invoice.id))
      .orderBy(asc(invoiceLinesTable.lineNo)),
    getDb()
      .select()
      .from(partiesTable)
      .where(
        inArray(partiesTable.id, [
          invoice.supplierPartyId,
          invoice.buyerPartyId,
        ]),
      ),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, invoice.id))
      .orderBy(desc(stampRecordsTable.createdAt))
      .limit(1),
    getDb()
      .select()
      .from(confirmationsTable)
      .where(eq(confirmationsTable.invoiceId, invoice.id))
      .orderBy(desc(confirmationsTable.createdAt)),
    getDb()
      .select()
      .from(settlementEventsTable)
      .where(eq(settlementEventsTable.invoiceId, invoice.id))
      .orderBy(desc(settlementEventsTable.occurredAt)),
    getDb()
      .select()
      .from(collectionAccountsTable)
      .where(
        and(
          eq(collectionAccountsTable.firmId, invoice.firmId),
          eq(collectionAccountsTable.clientPartyId, invoice.supplierPartyId),
          eq(collectionAccountsTable.active, true),
        ),
      )
      .orderBy(desc(collectionAccountsTable.createdAt))
      .limit(1),
    getDb()
      .select()
      .from(invoiceRoomEventsTable)
      .where(eq(invoiceRoomEventsTable.shareId, share.id))
      .orderBy(desc(invoiceRoomEventsTable.createdAt))
      .limit(100),
    getDb()
      .select()
      .from(invoiceRoomPaymentRequestsTable)
      .where(eq(invoiceRoomPaymentRequestsTable.shareId, share.id))
      .orderBy(desc(invoiceRoomPaymentRequestsTable.createdAt))
      .limit(10),
  ]);
  const supplier = parties.find((p) => p.id === invoice.supplierPartyId);
  const buyer = parties.find((p) => p.id === invoice.buyerPartyId);
  if (!supplier || !buyer)
    throw new DomainError("ROOM_NOT_FOUND", "Invoice parties not found", 404);
  const latestConfirmation = confirmations[0] ?? null;
  const identityVerified = Boolean(session.verifiedAt);
  const verifiedEmail =
    identityVerified && session.otpChannel === "email" && share.recipientEmail
      ? share.recipientEmail
      : null;
  return {
    room: {
      id: share.id,
      status: shareStatus(share),
      expiresAt: share.expiresAt.toISOString(),
      identityVerified,
      verifiedChannel: session.verifiedAt ? session.otpChannel : null,
      recipientEmail: maskEmail(share.recipientEmail),
      recipientPhone: maskPhone(share.recipientPhone),
    },
    invoice: {
      invoiceNumber: invoice.invoiceNumber,
      kind: invoice.kind,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      currency: invoice.currency,
      subtotal: invoice.subtotal,
      vatTotal: invoice.vatTotal,
      grandTotal: invoice.grandTotal,
      status: invoice.status,
      notes: invoice.notes,
    },
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      vatRate: line.vatRate,
      lineExtension: line.lineExtension,
      vatAmount: line.vatAmount,
    })),
    supplier: {
      legalName: supplier.legalName,
      tin: supplier.tin,
      tinValidated: supplier.tinValidated,
    },
    buyer: { legalName: buyer.legalName },
    stamp: stamps[0]
      ? {
          irn: stamps[0].irn,
          csid: stamps[0].csid,
          rail: stamps[0].rail,
          provider: stamps[0].provider,
          environment: stamps[0].environment,
          stampedAt: stamps[0].createdAt.toISOString(),
        }
      : null,
    confirmation: latestConfirmation
      ? {
          state: latestConfirmation.state,
          note: latestConfirmation.note,
          noSetOff: latestConfirmation.noSetOff,
          createdAt: latestConfirmation.createdAt.toISOString(),
        }
      : null,
    payment: {
      settled: invoice.status === "settled",
      latestEvidenceAt: settlements[0]?.occurredAt.toISOString() ?? null,
      instructions: accounts[0]
        ? {
            provider: accounts[0].provider,
            accountReference: accounts[0].accountReference,
            label: accounts[0].label,
          }
        : null,
      requests: payments.map((payment) => ({
        id: payment.id,
        provider: payment.provider,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
        checkoutUrl:
          payment.status === "pending" &&
          (!payment.expiresAt || payment.expiresAt.getTime() > Date.now())
            ? payment.checkoutUrl
            : null,
        expiresAt: payment.expiresAt?.toISOString() ?? null,
        confirmedAt: payment.confirmedAt?.toISOString() ?? null,
        createdAt: payment.createdAt.toISOString(),
      })),
    },
    permissions: {
      canRespond:
        identityVerified &&
        latestConfirmation?.state === "requested" &&
        isPresentableAsEligible(invoice.status),
      canReportPayment:
        identityVerified &&
        ACTIONABLE_STATUSES.has(invoice.status) &&
        invoice.status !== "settled",
      canCreatePaymentLink:
        identityVerified &&
        ACTIONABLE_STATUSES.has(invoice.status) &&
        invoice.status !== "settled",
      canClaimAccount: Boolean(verifiedEmail),
    },
    timeline: events
      .reverse()
      .filter((event) => PUBLIC_EVENT_KINDS.has(event.kind))
      .map((event) => ({
        id: event.id,
        kind: event.kind,
        detail: event.detail,
        createdAt: event.createdAt.toISOString(),
      })),
  };
}

export async function requestInvoiceRoomOtp(
  sessionToken: string,
  channel: "email" | "whatsapp",
): Promise<{ sentTo: string; expiresAt: string; debugCode?: string }> {
  const prepared = await runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken);
    const target =
      channel === "email"
        ? access.share.recipientEmail
        : access.share.recipientPhone;
    if (!target) {
      throw new DomainError(
        "VERIFICATION_CHANNEL_UNAVAILABLE",
        `This invoice link has no ${channel === "email" ? "email address" : "WhatsApp number"} to verify`,
        400,
      );
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const expiresAt = new Date(Date.now() + ROOM_OTP_TTL_MS);
    await getDb()
      .update(invoiceRoomSessionsTable)
      .set({
        otpHash: roomOtpDigest(sessionToken, code),
        otpExpiresAt: expiresAt,
        otpChannel: channel,
        verifiedAt: null,
        verifiedContactHash: null,
        updatedAt: new Date(),
      })
      .where(eq(invoiceRoomSessionsTable.id, access.session.id));
    await appendRoomEvent({
      share: access.share,
      kind: "otp_requested",
      actorType: "buyer_guest",
      detail: { channel },
      idempotencyKey: `otp:${access.session.id}:${expiresAt.getTime()}`,
    });
    return { access, target, code, expiresAt };
  });
  const delivery = await sendRawToRelay(
    "invoice_room_verify",
    {
      channel,
      to: prepared.target,
      code: prepared.code,
      expiresInMinutes: ROOM_OTP_TTL_MS / 60_000,
    },
    {
      idempotencyKey: `invoice-room-verify:${prepared.access.session.id}:${prepared.expiresAt.getTime()}`,
    },
  );
  if (!delivery.ok && process.env.NODE_ENV === "production") {
    throw new DomainError(
      "VERIFICATION_DELIVERY_UNAVAILABLE",
      "Verification delivery is temporarily unavailable",
      503,
    );
  }
  return {
    sentTo:
      channel === "email"
        ? maskEmail(prepared.target)!
        : maskPhone(prepared.target)!,
    expiresAt: prepared.expiresAt.toISOString(),
    ...(process.env.NODE_ENV !== "production"
      ? { debugCode: prepared.code }
      : {}),
  };
}

export async function verifyInvoiceRoomOtp(
  sessionToken: string,
  code: string,
): Promise<Awaited<ReturnType<typeof invoiceRoomView>>> {
  return runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken);
    const session = access.session;
    if (
      !session.otpHash ||
      !session.otpExpiresAt ||
      !session.otpChannel ||
      session.otpExpiresAt.getTime() <= Date.now() ||
      !safeDigestEqual(session.otpHash, roomOtpDigest(sessionToken, code))
    ) {
      throw new DomainError(
        "INVALID_ROOM_CODE",
        "Invalid or expired verification code",
        401,
      );
    }
    const target =
      session.otpChannel === "email"
        ? access.share.recipientEmail
        : access.share.recipientPhone;
    const [verified] = await getDb()
      .update(invoiceRoomSessionsTable)
      .set({
        verifiedAt: new Date(),
        verifiedContactHash: target ? digestRoomSecret(target) : null,
        otpHash: null,
        otpExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoiceRoomSessionsTable.id, session.id),
          eq(invoiceRoomSessionsTable.otpHash, session.otpHash),
        ),
      )
      .returning();
    if (!verified) {
      throw new DomainError(
        "INVALID_ROOM_CODE",
        "Invalid or expired verification code",
        401,
      );
    }
    await appendRoomEvent({
      share: access.share,
      kind: "identity_verified",
      actorType: "buyer_guest",
      actorRef: target ? digestRoomSecret(target).slice(0, 24) : null,
      detail: { channel: session.otpChannel },
      idempotencyKey: `verified:${session.id}`,
    });
    return invoiceRoomView({ ...access, session: verified });
  });
}

export async function respondInInvoiceRoom(
  sessionToken: string,
  input: {
    state: "confirmed" | "queried" | "rejected";
    note?: string | null;
    noSetOff?: boolean;
    idempotencyKey: string;
  },
) {
  return runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    if (
      (input.state === "queried" || input.state === "rejected") &&
      !input.note?.trim()
    ) {
      throw new DomainError(
        "RESPONSE_NOTE_REQUIRED",
        "Add a reason so the supplier can resolve this response",
        400,
      );
    }
    const roomEvent = await appendRoomEvent({
      share: access.share,
      kind: input.state,
      actorType: "buyer_guest",
      actorRef: access.session.verifiedContactHash,
      detail: {
        state: input.state,
        note: input.note?.trim() || null,
        noSetOff: input.noSetOff ?? false,
      },
      idempotencyKey: `response:${input.idempotencyKey}`,
    });
    if (roomEvent.created) {
      await recordConfirmation(
        access.invoice,
        {
          buyerPartyId: access.invoice.buyerPartyId,
          state: input.state,
          method: `invoice_room:${access.session.otpChannel}`,
          note: input.note?.trim() || undefined,
          noSetOff: input.noSetOff ?? false,
        },
        roomActor(access.share, access.invoice),
        { confirmingUserId: null },
      );
    }
    return invoiceRoomView(access);
  });
}

export async function reportInvoiceRoomPayment(
  sessionToken: string,
  input: {
    amount?: string;
    paidAt: string;
    reference: string;
    note?: string | null;
    idempotencyKey: string;
  },
) {
  return runInBypassContext(async () => {
    const initialAccess = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    const [lockedInvoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, initialAccess.invoice.id))
      .for("update")
      .limit(1);
    if (!lockedInvoice || lockedInvoice.firmId !== initialAccess.share.firmId) {
      throw new DomainError("ROOM_NOT_FOUND", "Invoice Room not found", 404);
    }
    const access = { ...initialAccess, invoice: lockedInvoice };
    if (!ACTIONABLE_STATUSES.has(lockedInvoice.status)) {
      throw new DomainError(
        "PAYMENT_NOT_REPORTABLE",
        `Invoice is ${lockedInvoice.status}`,
        409,
      );
    }
    const amount = resolvePaymentFlagAmount(
      "paid",
      input.amount,
      access.invoice.grandTotal,
    );
    const occurredAt = new Date(input.paidAt);
    if (occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new DomainError(
        "PAYMENT_DATE_INVALID",
        "Payment date cannot be in the future",
        400,
      );
    }
    const actor = roomActor(access.share, access.invoice);
    const { event, created } = await appendSettlementEvent({
      invoiceId: access.invoice.id,
      source: "buyer_flag",
      amount,
      paymentStatus: "paid",
      actorId: actor.userId,
      externalReference: `invoice-room-report:${digestRoomSecret(`${access.share.id}:${input.idempotencyKey}`)}`,
      occurredAt,
    });
    if (created) {
      await tryTransition(access.invoice, "settled", {
        actorId: actor.userId,
        actorRole: actor.role,
        reason: "invoice_room:buyer_reported_paid",
      });
      await appendRoomEvent({
        share: access.share,
        kind: "payment_reported",
        actorType: "buyer_guest",
        actorRef: access.session.verifiedContactHash,
        detail: {
          amount,
          paidAt: occurredAt.toISOString(),
          reference: input.reference.trim(),
          note: input.note?.trim() || null,
        },
        idempotencyKey: `payment-report:${input.idempotencyKey}`,
      });
      await appendAudit({
        actorId: actor.userId,
        actorRole: actor.role,
        firmId: access.invoice.firmId,
        action: "invoice_room.payment_reported",
        entityType: "settlement_event",
        entityId: event.id,
        after: { invoiceRoomId: access.share.id, source: "buyer_flag" },
      });
    }
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, access.invoice.id))
      .limit(1);
    return invoiceRoomView({ ...access, invoice: invoice ?? access.invoice });
  });
}

export async function createInvoiceRoomPaymentLink(
  sessionToken: string,
  idempotencyKey: string,
  signal?: AbortSignal,
) {
  return withProviderOperationLock(
    `invoice-room-payment:${digestRoomSecret(`${sessionToken}:${idempotencyKey}`)}`,
    async () => {
      const reserved = await runInBypassContext(async () => {
        const access = await loadRoomAccess(sessionToken, {
          requireVerified: true,
        });
        if (access.invoice.status === "settled") {
          throw new DomainError(
            "INVOICE_ALREADY_SETTLED",
            "This invoice is already settled",
            409,
          );
        }
        const [existing] = await getDb()
          .select()
          .from(invoiceRoomPaymentRequestsTable)
          .where(
            and(
              eq(invoiceRoomPaymentRequestsTable.shareId, access.share.id),
              eq(
                invoiceRoomPaymentRequestsTable.idempotencyKey,
                idempotencyKey,
              ),
            ),
          )
          .limit(1);
        if (existing?.providerReference && existing.checkoutUrl) {
          return { access, row: existing, finalized: true as const };
        }
        if (existing)
          return { access, row: existing, finalized: false as const };
        const [created] = await getDb()
          .insert(invoiceRoomPaymentRequestsTable)
          .values({
            firmId: access.invoice.firmId,
            invoiceId: access.invoice.id,
            shareId: access.share.id,
            provider: "relay",
            amount: access.invoice.grandTotal,
            currency: access.invoice.currency,
            idempotencyKey,
          })
          .onConflictDoNothing()
          .returning();
        if (!created) {
          throw new DomainError(
            "PAYMENT_REQUEST_CONFLICT",
            "Payment request is already in progress",
            409,
          );
        }
        return { access, row: created, finalized: false as const };
      });
      if (reserved.finalized) return paymentRequestView(reserved.row);
      const initialized = await initializeInvoicePayment(
        {
          invoiceId: reserved.access.invoice.id,
          invoiceNumber: reserved.access.invoice.invoiceNumber,
          amount: reserved.row.amount,
          currency: reserved.row.currency,
          idempotencyKey: `invoice-room:${reserved.access.share.id}:${idempotencyKey}`,
        },
        signal,
      );
      return runInBypassContext(async () => {
        const [finalized] = await getDb()
          .update(invoiceRoomPaymentRequestsTable)
          .set({
            provider: initialized.provider,
            providerReference: initialized.providerReference,
            checkoutUrl: initialized.checkoutUrl,
            expiresAt: initialized.expiresAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(invoiceRoomPaymentRequestsTable.id, reserved.row.id),
              eq(invoiceRoomPaymentRequestsTable.status, "pending"),
              isNull(invoiceRoomPaymentRequestsTable.providerReference),
            ),
          )
          .returning();
        const row = finalized ?? reserved.row;
        await appendRoomEvent({
          share: reserved.access.share,
          kind: "payment_link_created",
          actorType: "buyer_guest",
          actorRef: reserved.access.session.verifiedContactHash,
          detail: { provider: initialized.provider },
          idempotencyKey: `payment-link:${idempotencyKey}`,
        });
        return paymentRequestView(row);
      });
    },
  );
}

function paymentRequestView(
  row: typeof invoiceRoomPaymentRequestsTable.$inferSelect,
) {
  return {
    id: row.id,
    provider: row.provider,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    checkoutUrl: row.checkoutUrl,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function confirmInvoiceRoomPayment(input: {
  providerReference: string;
  amount: string;
  currency: string;
  paidAt?: string;
}): Promise<{ applied: boolean }> {
  return runInBypassContext(async () => {
    const [request] = await getDb()
      .select()
      .from(invoiceRoomPaymentRequestsTable)
      .where(
        eq(
          invoiceRoomPaymentRequestsTable.providerReference,
          input.providerReference,
        ),
      )
      .for("update")
      .limit(1);
    if (!request || request.status !== "pending") return { applied: false };
    if (
      request.currency !== input.currency ||
      decimalToMinorUnits(input.amount) < decimalToMinorUnits(request.amount)
    ) {
      return { applied: false };
    }
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(eq(invoicesTable.id, request.invoiceId))
      .for("update")
      .limit(1);
    const [share] = await getDb()
      .select()
      .from(invoiceRoomSharesTable)
      .where(eq(invoiceRoomSharesTable.id, request.shareId))
      .limit(1);
    if (!invoice || !share) return { applied: false };
    // Deliberately no assertShareActive here: a payment link is only issued
    // while the share is active, so a pending request always predates any
    // revocation or expiry, and money the buyer actually paid must land as
    // settlement evidence regardless of what happened to the link afterwards
    // (R105 review). Revocation stops NEW links and views, never a settled payment.
    const occurredAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const { event, created } = await appendSettlementEvent({
      invoiceId: invoice.id,
      source: "payment_provider",
      amount: input.amount,
      actorId: null,
      externalReference: `invoice-payment:${request.provider}:${input.providerReference}`,
      occurredAt,
    });
    if (!created) return { applied: false };
    await getDb()
      .update(invoiceRoomPaymentRequestsTable)
      .set({
        status: "confirmed",
        confirmedAt: occurredAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(invoiceRoomPaymentRequestsTable.id, request.id),
          eq(invoiceRoomPaymentRequestsTable.status, "pending"),
        ),
      );
    await tryTransition(invoice, "settled", {
      actorId: null,
      actorRole: "system",
      reason: "invoice_room:provider_payment",
    });
    await appendRoomEvent({
      share,
      kind: "payment_confirmed",
      actorType: "system",
      detail: { provider: request.provider, amount: input.amount },
      idempotencyKey: `provider-confirmed:${input.providerReference}`,
    });
    await appendAudit({
      firmId: invoice.firmId,
      action: "invoice_room.payment_confirmed",
      entityType: "settlement_event",
      entityId: event.id,
      after: { invoiceRoomId: share.id, provider: request.provider },
    });
    return { applied: true };
  });
}

export async function claimInvoiceRoomAccount(
  sessionToken: string,
  input: { fullName?: string | null; password?: string | null },
): Promise<{
  created: boolean;
  loginRequired: boolean;
  buyerPath: string;
  sessionToken?: string;
}> {
  const identity = await runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    if (access.session.otpChannel !== "email" || !access.share.recipientEmail) {
      throw new DomainError(
        "VERIFIED_EMAIL_REQUIRED",
        "Verify the email address on this invoice link before creating an account",
        400,
      );
    }
    const email = normalizeEmail(access.share.recipientEmail);
    const [existing] = await getDb()
      .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    return { access, email, existing };
  });
  if (!identity.existing && (!input.password || input.password.length < 12)) {
    throw new DomainError(
      "PASSWORD_REQUIRED",
      "Create a password with at least 12 characters",
      400,
    );
  }
  const passwordHash = identity.existing
    ? null
    : await hashPassword(input.password!);
  const result = await runInBypassContext(async () => {
    const access = await loadRoomAccess(sessionToken, {
      requireVerified: true,
    });
    const [current] = await getDb()
      .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
      .from(usersTable)
      .where(eq(usersTable.email, identity.email))
      .limit(1);
    let user = current;
    let created = false;
    if (!user) {
      const [inserted] = await getDb()
        .insert(usersTable)
        .values({
          email: identity.email,
          fullName: input.fullName?.trim() || null,
          passwordHash,
        })
        .onConflictDoNothing({ target: usersTable.email })
        .returning({
          id: usersTable.id,
          sessionEpoch: usersTable.sessionEpoch,
        });
      user = inserted;
      created = Boolean(inserted);
      if (!user) {
        const [winner] = await getDb()
          .select({ id: usersTable.id, sessionEpoch: usersTable.sessionEpoch })
          .from(usersTable)
          .where(eq(usersTable.email, identity.email))
          .limit(1);
        user = winner;
      }
    }
    if (!user)
      throw new DomainError(
        "ACCOUNT_CLAIM_FAILED",
        "Account could not be created",
        409,
      );
    await getDb()
      .insert(membershipsTable)
      .values({
        userId: user.id,
        firmId: null,
        role: "buyer_user",
        clientPartyId: null,
        buyerPartyId: access.invoice.buyerPartyId,
      })
      .onConflictDoNothing();
    await appendRoomEvent({
      share: access.share,
      kind: "claimed",
      actorType: "buyer_user",
      actorRef: digestRoomSecret(user.id).slice(0, 24),
      detail: { created },
      idempotencyKey: `claimed:${user.id}`,
    });
    await appendAudit({
      actorId: user.id,
      actorRole: "buyer_user",
      firmId: access.invoice.firmId,
      action: "invoice_room.account_claimed",
      entityType: "invoice_room",
      entityId: access.share.id,
      after: { buyerPartyId: access.invoice.buyerPartyId, created },
    });
    return { user, created };
  });
  return {
    created: result.created,
    loginRequired: !result.created,
    buyerPath: "/buyer/",
    ...(result.created
      ? {
          sessionToken: await issueSessionToken(
            result.user.id,
            result.user.sessionEpoch,
          ),
        }
      : {}),
  };
}

export async function renderableInvoiceRoomBundle(sessionToken: string) {
  const access = await loadRoomAccess(sessionToken);
  const [lines, parties, stamps] = await Promise.all([
    getDb()
      .select()
      .from(invoiceLinesTable)
      .where(eq(invoiceLinesTable.invoiceId, access.invoice.id))
      .orderBy(asc(invoiceLinesTable.lineNo)),
    getDb()
      .select()
      .from(partiesTable)
      .where(
        inArray(partiesTable.id, [
          access.invoice.supplierPartyId,
          access.invoice.buyerPartyId,
        ]),
      ),
    getDb()
      .select()
      .from(stampRecordsTable)
      .where(eq(stampRecordsTable.invoiceId, access.invoice.id))
      .orderBy(desc(stampRecordsTable.createdAt))
      .limit(1),
  ]);
  const supplier = parties.find((p) => p.id === access.invoice.supplierPartyId);
  const buyer = parties.find((p) => p.id === access.invoice.buyerPartyId);
  if (!supplier || !buyer)
    throw new DomainError("ROOM_NOT_FOUND", "Invoice parties not found", 404);
  return { access, lines, supplier, buyer, stamp: stamps[0] ?? null };
}

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
        lit.set(share.firmId, await isFeatureEnabled("invoice_room", share.firmId));
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
