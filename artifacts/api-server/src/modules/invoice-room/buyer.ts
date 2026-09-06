import { randomInt } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
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
  partiesTable,
  runInBypassContext,
  settlementEventsTable,
  stampRecordsTable,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { recordConfirmation } from "../invoice/confirmations";
import { isPresentableAsEligible, tryTransition } from "../invoice/lifecycle";
import { appendSettlementEvent } from "../invoice/settlement";
import { sendRawToRelay } from "../messaging/messaging";
import { resolvePaymentFlagAmount } from "../../lib/parse";
import {
  digestRoomSecret,
  makeRoomSecret,
  maskEmail,
  maskPhone,
  roomOtpDigest,
  ROOM_OTP_TTL_MS,
  ROOM_SESSION_TTL_MS,
  safeDigestEqual,
} from "./security";
import {
  ACTIONABLE_STATUSES,
  PUBLIC_EVENT_KINDS,
  roomActor,
  shareStatus,
  assertRoomFeature,
  assertShareActive,
  loadRoomAccess,
  appendRoomEvent,
} from "./core";
import type { RoomAccess } from "./core";

// The buyer side of an Invoice Room (R109: split out of service.ts): the
// link-to-session exchange, the room view, one-time-code verification and
// the buyer's responses and payment reports. Every mutation requires a
// verified session (`requireVerified: true`), pinned by the posture test.

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
