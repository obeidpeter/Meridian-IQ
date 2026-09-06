import { and, eq, isNull } from "drizzle-orm";
import {
  getDb,
  invoiceRoomPaymentRequestsTable,
  invoiceRoomSharesTable,
  invoicesTable,
  runInBypassContext,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { tryTransition } from "../invoice/lifecycle";
import { appendSettlementEvent } from "../invoice/settlement";
import { decimalToMinorUnits } from "../../lib/money";
import { withProviderOperationLock } from "../../lib/provider-operation-lock";
import { initializeInvoicePayment } from "./provider";
import { digestRoomSecret } from "./security";
import { loadRoomAccess, appendRoomEvent } from "./core";

// Hosted payment links and provider confirmations for an Invoice Room (R109:
// split out of service.ts). A pending request always predates any revocation,
// so confirmation deliberately does not re-check the share (R105 review).

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
