import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, like, notLike, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  collectionAccountsTable,
  invoicesTable,
  settlementEventsTable,
  type CollectionAccountRow,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import {
  assertPartyAccess,
  requireFirmScope,
  type Principal,
} from "../auth/rbac";
import { canTransition, recordTransition } from "../invoice/lifecycle";
import { OUTSTANDING_STATUSES } from "../invoice/receivables";
import { provisionAccount } from "./provider";
import { decimalToMinorUnits } from "../../lib/money";
import { DomainError } from "../errors";
import { withProviderOperationLock } from "../../lib/provider-operation-lock";

// Collection accounts: one virtual account reference per client, provisioned
// through the provider seam (provider.ts — simulator unless
// COLLECTION_PROVIDER_URL lights a relay). Inbound payments on the reference
// arrive ONLY through the off-contract webhook (routes/collections.ts,
// fail-closed behind COLLECTION_WEBHOOK_TOKEN) and become append-only
// `collection_account` settlement events — the mandatory-source settlement
// hierarchy's auto-observed member (CR-01, Plan 7.4).

// Receivable statuses a payment can bind to: post-submission, pre-terminal —
// exactly the outstanding set (OUTSTANDING_STATUSES, invoice/receivables.ts),
// and DERIVED from it because a payment can bind precisely to an outstanding
// receivable: draft/validated paper has no fixed number the payer could be
// quoting; settled/cancelled/credited must not resurrect (the CAS below also
// guards).
const BINDABLE_STATUSES = OUTSTANDING_STATUSES;

export async function createCollectionAccount(
  principal: Principal,
  input: { clientPartyId: string; label?: string | null },
  signal?: AbortSignal,
): Promise<CollectionAccountRow> {
  const firmId = requireFirmScope(principal);
  return withProviderOperationLock(
    `collection:${firmId}:${input.clientPartyId}`,
    async () => {
      const inFirmScope = <T>(fn: () => Promise<T>) =>
        runRequestContext({ bypass: false, firmId }, fn);
      const label = input.label ?? null;
      const reservation = await inFirmScope(async () => {
        // The named client must be one this firm engages. The explicit scope is
        // also the RLS boundary because the provider route has no ambient request
        // transaction while it waits on the relay.
        await assertPartyAccess(principal, input.clientPartyId);
        const [existing] = await getDb()
          .select()
          .from(collectionAccountsTable)
          .where(
            and(
              eq(collectionAccountsTable.firmId, firmId),
              eq(collectionAccountsTable.clientPartyId, input.clientPartyId),
              eq(collectionAccountsTable.active, true),
            ),
          )
          .limit(1);
        if (existing && !existing.accountReference.startsWith("pending:")) {
          throw new DomainError(
            "COLLECTION_ACCOUNT_EXISTS",
            "This client already has an active collection account",
            409,
          );
        }
        const [generation] = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(collectionAccountsTable)
          .where(
            and(
              eq(collectionAccountsTable.firmId, firmId),
              eq(collectionAccountsTable.clientPartyId, input.clientPartyId),
              notLike(collectionAccountsTable.accountReference, "pending:%"),
            ),
          );
        if (existing) {
          return {
            row: existing,
            generation: Number(generation?.count ?? 0) + 1,
          };
        }

        const [created] = await getDb()
          .insert(collectionAccountsTable)
          .values({
            firmId,
            clientPartyId: input.clientPartyId,
            provider: process.env.COLLECTION_PROVIDER_URL
              ? "relay"
              : "simulator",
            accountReference: `pending:${randomUUID()}`,
            label,
            active: true,
            createdByUserId: principal.userId,
          })
          .onConflictDoNothing()
          .returning();
        if (created) {
          return {
            row: created,
            generation: Number(generation?.count ?? 0) + 1,
          };
        }
        const [winner] = await getDb()
          .select()
          .from(collectionAccountsTable)
          .where(
            and(
              eq(collectionAccountsTable.firmId, firmId),
              eq(collectionAccountsTable.clientPartyId, input.clientPartyId),
              eq(collectionAccountsTable.active, true),
            ),
          )
          .limit(1);
        if (winner?.accountReference.startsWith("pending:")) {
          return {
            row: winner,
            generation: Number(generation?.count ?? 0) + 1,
          };
        }
        throw new DomainError(
          "COLLECTION_ACCOUNT_EXISTS",
          "This client already has an active collection account",
          409,
        );
      });

      const provision = await provisionAccount(
        {
          firmId,
          clientPartyId: input.clientPartyId,
          // Keep a retry byte-for-byte consistent with the committed reservation.
          label: reservation.row.label ?? null,
          idempotencyKey: `collection:${firmId}:${input.clientPartyId}:${reservation.generation}`,
        },
        signal,
      );
      return inFirmScope(async () => {
        const [finalized] = await getDb()
          .update(collectionAccountsTable)
          .set({ accountReference: provision.accountReference })
          .where(
            and(
              eq(collectionAccountsTable.id, reservation.row.id),
              eq(collectionAccountsTable.active, true),
              like(collectionAccountsTable.accountReference, "pending:%"),
            ),
          )
          .returning();
        if (!finalized) {
          const [current] = await getDb()
            .select()
            .from(collectionAccountsTable)
            .where(eq(collectionAccountsTable.id, reservation.row.id))
            .limit(1);
          if (
            current?.active &&
            !current.accountReference.startsWith("pending:")
          ) {
            return current;
          }
          throw new DomainError(
            "COLLECTION_RESERVATION_LOST",
            "Collection account reservation is no longer available",
            409,
          );
        }
        // Pointer-only audit: the row carries the provider reference for
        // authorized readers.
        await appendAudit({
          actorId: principal.userId,
          actorRole: principal.role,
          firmId,
          action: "collections.account_created",
          entityType: "collection_account",
          entityId: finalized.id,
          after: {
            clientPartyId: finalized.clientPartyId,
            provider: finalized.provider,
          },
        });
        return finalized;
      });
    },
  );
}

// The client's accounts, newest first. Callers hold statement.write and have
// already asserted party access; firm isolation is RLS at the data layer.
export async function listCollectionAccounts(
  clientPartyId: string,
): Promise<CollectionAccountRow[]> {
  return getDb()
    .select()
    .from(collectionAccountsTable)
    .where(
      and(
        eq(collectionAccountsTable.clientPartyId, clientPartyId),
        notLike(collectionAccountsTable.accountReference, "pending:%"),
      ),
    )
    .orderBy(desc(collectionAccountsTable.createdAt));
}

// Deactivate: the webhook stops resolving the reference; the row stays as
// provenance. Idempotent — the flip is a CAS on active=true, so a replay
// changes nothing and simply returns the (already inactive) row.
export async function deactivateCollectionAccount(
  id: string,
): Promise<CollectionAccountRow | null> {
  const [flipped] = await getDb()
    .update(collectionAccountsTable)
    .set({ active: false, updatedAt: new Date() })
    .where(
      and(
        eq(collectionAccountsTable.id, id),
        eq(collectionAccountsTable.active, true),
      ),
    )
    .returning();
  if (flipped) return flipped;
  const [row] = await getDb()
    .select()
    .from(collectionAccountsTable)
    .where(eq(collectionAccountsTable.id, id))
    .limit(1);
  return row ?? null;
}

export interface InboundCollectionInput {
  accountReference: string;
  // 2dp decimal string — validated by the route's local schema.
  amount: string;
  invoiceNumber: string;
  reference: string;
  // ISO datetime; absent means "now".
  paidAt?: string | null;
}

// Record an inbound payment from the collection provider's webhook. Runs on a
// NO_CONTEXT route (app.ts), so it opens its OWN short bypass transaction —
// the machine caller has no tenant, exactly confirmPaymentIntent's posture —
// and event + CAS + lifecycle + audit commit together before the 202 goes
// out. Unknown and inactive references return {applied:false} SILENTLY (no
// audit): the route answers 202 either way, so a caller holding the shared
// secret still cannot probe which references are live.
export async function recordInboundCollection(
  input: InboundCollectionInput,
): Promise<{ applied: boolean }> {
  return runInBypassContext(async () => {
    const [account] = await getDb()
      .select()
      .from(collectionAccountsTable)
      .where(
        and(
          eq(collectionAccountsTable.accountReference, input.accountReference),
          eq(collectionAccountsTable.active, true),
        ),
      )
      .limit(1);
    if (!account) return { applied: false };

    const externalReference = `collection:${account.provider}:${account.id}:${createHash(
      "sha256",
    )
      .update(input.reference)
      .digest("hex")}`;
    const [replayed] = await getDb()
      .select({ id: settlementEventsTable.id })
      .from(settlementEventsTable)
      .where(eq(settlementEventsTable.externalReference, externalReference))
      .limit(1);
    if (replayed) return { applied: false };

    // Bind the payment to the client's receivable by invoice number: the
    // account's firm and client pin the search, so a stranger's coincidental
    // number can never be settled cross-tenant. kind=invoice only — credit
    // notes and corrections are never settlement targets.
    const [invoice] = await getDb()
      .select()
      .from(invoicesTable)
      .where(
        and(
          eq(invoicesTable.firmId, account.firmId),
          eq(invoicesTable.supplierPartyId, account.clientPartyId),
          eq(invoicesTable.invoiceNumber, input.invoiceNumber),
          eq(invoicesTable.kind, "invoice"),
          inArray(invoicesTable.status, [...BINDABLE_STATUSES, "settled"]),
        ),
      )
      .for("update")
      .limit(1);
    if (!invoice) {
      // A live account took a payment we cannot bind — that is worth an
      // operator's attention, unlike an unknown reference. Pointer-only:
      // no amounts, no payer free text (the provider's payload is untrusted).
      await appendAudit({
        firmId: account.firmId,
        action: "collections.unmatched",
        entityType: "collection_account",
        entityId: account.id,
        after: { hasInvoiceNumber: Boolean(input.invoiceNumber) },
      });
      return { applied: false };
    }

    // Append-only settlement lineage: each unique provider reference is one
    // event row. A replay is absorbed by the unique external-reference index;
    // actorId null marks the machine observer.
    const occurredAt = input.paidAt ? new Date(input.paidAt) : new Date();
    const [event] = await getDb()
      .insert(settlementEventsTable)
      .values({
        invoiceId: invoice.id,
        source: "collection_account",
        amount: input.amount,
        paymentStatus: "paid",
        actorId: null,
        externalReference,
        occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: settlementEventsTable.id });
    if (!event) return { applied: false };

    const [paid] = await getDb()
      .select({
        amount: sql<string>`COALESCE(sum(${settlementEventsTable.amount}), 0)::text`,
      })
      .from(settlementEventsTable)
      .where(
        and(
          eq(settlementEventsTable.invoiceId, invoice.id),
          eq(settlementEventsTable.source, "collection_account"),
          eq(settlementEventsTable.paymentStatus, "paid"),
        ),
      );
    const fullyPaid =
      decimalToMinorUnits(paid?.amount ?? "0") >=
      decimalToMinorUnits(invoice.grandTotal);

    // Mirror the buyer paid-flag branch exactly (routes/buyer.ts):
    // compare-and-set so a concurrent cancel/credit (or an earlier replay
    // that already settled) wins — the event stands as lineage but the
    // settled transition is skipped. A `submitted` receivable records the
    // event only (the state machine settles from stamped/confirmed).
    if (fullyPaid && canTransition(invoice.status, "settled")) {
      const [moved] = await getDb()
        .update(invoicesTable)
        .set({ status: "settled" })
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
          toStatus: "settled",
          actorId: null,
          actorRole: "system",
          reason: "collection_account",
        });
      }
    }

    // Pointer-only audit (never amounts): the settlement event carries the
    // figures for whoever is entitled to read them.
    await appendAudit({
      firmId: invoice.firmId,
      action: "collections.settlement",
      entityType: "invoice",
      entityId: invoice.id,
      after: { collectionAccountId: account.id, source: "collection_account" },
    });
    return { applied: true };
  });
}
