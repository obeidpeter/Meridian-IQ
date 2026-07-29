import { and, desc, eq } from "drizzle-orm";
import {
  getDb,
  confirmationsTable,
  invoicesTable,
  partiesTable,
  type Invoice,
} from "@workspace/db";
import { DomainError } from "../errors";
import {
  canTransition,
  isPresentableAsEligible,
  recordTransition,
} from "./lifecycle";
import { appendAudit } from "../audit/audit";
import { isFeatureEnabled } from "../flags/flags";
import { sendMessage } from "../messaging/messaging";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { logger } from "../../lib/logger";
import type { Principal } from "../auth/rbac";

// BR-02 confirmation domain rules (extracted from the route in the
// invoices.ts split round — the route keeps auth/scope resolution, this
// module owns everything after "which invoice, which caller" is settled):
// the buyer-party pin, the TIN gate, the record-level state machine over the
// append-only lineage, the compare-and-set status transition, the
// best-effort buyer nudge and the audit row.

export type ConfirmationRow = typeof confirmationsTable.$inferSelect;

export interface ConfirmationInput {
  buyerPartyId: string;
  state: "requested" | "confirmed" | "queried" | "rejected";
  method?: string;
  noSetOff?: boolean;
  note?: string;
}

// Record one confirmation-lineage row for an ALREADY-AUTHORIZED invoice.
// The caller must have resolved scope first: the supplier's firm via the
// tenant loader for a request, the buyer organization via buyer-party access
// for a response — this function trusts `invoice` and re-derives nothing
// about the principal beyond identity for lineage/audit.
export async function recordConfirmation(
  invoice: Invoice,
  input: ConfirmationInput,
  principal: Principal,
): Promise<ConfirmationRow> {
  const isRequest = input.state === "requested";

  // The confirmation always belongs to the invoice's own buyer; a mismatched
  // body buyerPartyId must never be trusted (it would bypass the TIN gate and
  // could reference a cross-tenant party).
  if (input.buyerPartyId !== invoice.buyerPartyId) {
    throw new DomainError(
      "BUYER_PARTY_MISMATCH",
      "Confirmation buyerPartyId must match the invoice buyer",
      409,
    );
  }
  // A party without a validated TIN cannot enter the confirmation workflow
  // (CORE-08 / BR-02): confirmations feed VAT protection and financeability.
  const [buyer] = await getDb()
    .select({ tinValidated: partiesTable.tinValidated })
    .from(partiesTable)
    .where(eq(partiesTable.id, invoice.buyerPartyId))
    .limit(1);
  if (!buyer?.tinValidated) {
    throw new DomainError(
      "TIN_NOT_VALIDATED",
      "Buyer TIN must be validated before entering the confirmation workflow",
      422,
    );
  }

  // Record-level state machine over the append-only lineage.
  const [latest] = await getDb()
    .select()
    .from(confirmationsTable)
    .where(eq(confirmationsTable.invoiceId, invoice.id))
    .orderBy(desc(confirmationsTable.createdAt))
    .limit(1);
  if (isRequest) {
    // Confirmation is requested on a stamped invoice; re-requesting is allowed
    // only after a queried/rejected response (Appendix B).
    if (invoice.status !== "stamped") {
      throw new DomainError(
        "NOT_STAMPED",
        "Confirmation can only be requested on a stamped invoice",
        409,
      );
    }
    if (latest && (latest.state === "requested" || latest.state === "confirmed")) {
      throw new DomainError(
        "CONFIRMATION_ALREADY_OPEN",
        `Confirmation is already ${latest.state}`,
        409,
      );
    }
  } else {
    if (!latest || latest.state !== "requested") {
      throw new DomainError(
        "NO_OPEN_REQUEST",
        "A confirmation response requires an open request",
        409,
      );
    }
    if (!input.method) {
      throw new DomainError(
        "METHOD_REQUIRED",
        "A confirmation response must state its method",
        400,
      );
    }
    // CORE-09: an invoice cancelled or credited after the request was raised
    // can no longer collect a confirmation (a confirmed dead invoice would
    // read as financeable evidence).
    if (!isPresentableAsEligible(invoice.status)) {
      throw new DomainError(
        "INVOICE_NOT_ELIGIBLE",
        `Invoice is ${invoice.status}; the confirmation request is void`,
        409,
      );
    }
  }

  const [row] = await getDb()
    .insert(confirmationsTable)
    .values({
      invoiceId: invoice.id,
      buyerPartyId: invoice.buyerPartyId,
      state: input.state,
      method: input.method ?? null,
      noSetOff: input.noSetOff ?? false,
      note: input.note ?? null,
      // BR-02: the confirming user is captured on buyer responses with lineage.
      confirmingUserId: isRequest ? null : principal.userId,
    })
    .returning();
  if (input.state === "confirmed" && canTransition(invoice.status, "confirmed")) {
    // Compare-and-set: if the invoice moved concurrently (cancel/credit), the
    // confirmation row stands as lineage but the status transition is skipped.
    const [moved] = await getDb()
      .update(invoicesTable)
      .set({ status: "confirmed" })
      .where(
        and(
          eq(invoicesTable.id, invoice.id),
          eq(invoicesTable.status, invoice.status),
        ),
      )
      .returning({ id: invoicesTable.id });
    if (moved) {
      await recordTransition({
        invoiceId: invoice.id,
        firmId: invoice.firmId,
        fromStatus: invoice.status,
        toStatus: "confirmed",
        actorId: principal.userId,
        actorRole: principal.role,
      });
    }
  }
  if (isRequest) {
    // Best-effort nudge to the buyer organization: a confirmation request is
    // only useful if the buyer learns of it. Gated like every send rail by
    // the messaging_notifications flag (dark flag = no ledger row, PL-02) and
    // pointer-only throughout (SEC-12) — the message carries an opaque party
    // ref and an invoice entity pointer, never amounts, names or the raw ids.
    // The buyer-party identity stamp (recipientPartyId) is what the
    // notification feed resolves by. Failures are absorbed: the confirmation
    // row above is the source of truth and must never be lost to a messaging
    // hiccup — the send runs in its own nested transaction (savepoint under
    // the request transaction) so even an aborted insert cannot poison the
    // surrounding commit.
    try {
      if (await isFeatureEnabled("messaging_notifications", null)) {
        await getDb().transaction(async () => {
          await sendMessage({
            channel: "email",
            recipientRef: pointerEntityRef("pty", invoice.buyerPartyId),
            recipientPartyId: invoice.buyerPartyId,
            templateKey: "confirmation_request",
            entityType: "invoice",
            entityId: pointerEntityRef("inv", invoice.id),
          });
        });
      }
    } catch (err) {
      logger.warn({ err }, "confirmation request notification failed");
    }
  }
  await appendAudit({
    actorId: principal.userId,
    firmId: invoice.firmId,
    action: "invoice.confirmation",
    entityType: "confirmation",
    entityId: row.id,
    after: { state: row.state, method: row.method, noSetOff: row.noSetOff },
  });
  return row;
}
