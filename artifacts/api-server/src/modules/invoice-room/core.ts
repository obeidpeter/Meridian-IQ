import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  invoiceRoomEventsTable,
  invoiceRoomSessionsTable,
  invoiceRoomSharesTable,
  invoicesTable,
  runInBypassContext,
  type Invoice,
  type InvoiceRoomShare,
} from "@workspace/db";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { digestRoomSecret, maskEmail, maskPhone } from "./security";

// The Invoice Room kernel (R109: split out of service.ts): the shared types,
// the share/session loaders and their status asserts, and the append-only
// room event ledger every flow writes through. Flow modules (supplier, buyer,
// payments, claim, reminders) import from here and never from each other's
// internals; service.ts re-exports the public surface unchanged.

export const SHAREABLE_STATUSES = ["stamped", "confirmed", "settled"] as const;

export const ACTIONABLE_STATUSES = new Set<string>(SHAREABLE_STATUSES);

export const PUBLIC_EVENT_KINDS = new Set([
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

export function roomActor(
  share: InvoiceRoomShare,
  invoice: Invoice,
): Principal {
  return {
    userId: `invoice-room:${share.id}`,
    role: "buyer_user",
    firmId: null,
    clientPartyId: null,
    buyerPartyId: invoice.buyerPartyId,
  };
}

export function shareStatus(
  share: Pick<InvoiceRoomShare, "revokedAt" | "expiresAt">,
): "active" | "expired" | "revoked" {
  if (share.revokedAt) return "revoked";
  return share.expiresAt.getTime() <= Date.now() ? "expired" : "active";
}

export function maskedRecipient(share: InvoiceRoomShare): string | null {
  if (share.deliveryChannel === "whatsapp")
    return maskPhone(share.recipientPhone);
  if (share.deliveryChannel === "email") return maskEmail(share.recipientEmail);
  return maskEmail(share.recipientEmail) ?? maskPhone(share.recipientPhone);
}

export async function assertRoomFeature(firmId: string): Promise<void> {
  if (!(await isFeatureEnabled("invoice_room", firmId))) {
    throw new DomainError("NOT_FOUND", "Invoice Room not found", 404);
  }
}

export function assertShareActive(share: InvoiceRoomShare): void {
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
  return runInBypassContext(
    async () => (await loadRoomAccess(sessionToken)).share.id,
  );
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

export async function appendRoomEvent(input: {
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
