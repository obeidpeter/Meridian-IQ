import { and, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  collectionAccountsTable,
  invoicesTable,
  settlementEventsTable,
  type CollectionAccountRow,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { assertPartyAccess, requireFirmScope, type Principal } from "../auth/rbac";
import { canTransition, recordTransition } from "../invoice/lifecycle";
import { provisionAccount } from "./provider";

// Collection accounts: one virtual account reference per client, provisioned
// through the provider seam (provider.ts — simulator unless
// COLLECTION_PROVIDER_URL lights a relay). Inbound payments on the reference
// arrive ONLY through the off-contract webhook (routes/collections.ts,
// fail-closed behind COLLECTION_WEBHOOK_TOKEN) and become append-only
// `collection_account` settlement events — the mandatory-source settlement
// hierarchy's auto-observed member (CR-01, Plan 7.4).

// Receivable statuses a payment can bind to: post-submission, pre-terminal.
// draft/validated paper has no fixed number the payer could be quoting;
// settled/cancelled/credited must not resurrect (the CAS below also guards).
const BINDABLE_STATUSES = ["submitted", "stamped", "confirmed"] as const;

export async function createCollectionAccount(
  principal: Principal,
  input: { clientPartyId: string; label?: string | null },
): Promise<CollectionAccountRow> {
  const firmId = requireFirmScope(principal);
  // The named client must be one this firm engages (the
  // statement-connections POST posture; a client_user could never reach here
  // — statement.write excludes the role entirely).
  await assertPartyAccess(principal, input.clientPartyId);
  const label = input.label ?? null;
  const provision = await provisionAccount({
    firmId,
    clientPartyId: input.clientPartyId,
    label,
  });
  const [row] = await getDb()
    .insert(collectionAccountsTable)
    .values({
      firmId,
      clientPartyId: input.clientPartyId,
      // Provider name derives from the same env the seam reads: dark
      // deployments record the simulator, lit ones the relay.
      provider: process.env.COLLECTION_PROVIDER_URL ? "relay" : "simulator",
      accountReference: provision.accountReference,
      label,
      createdByUserId: principal.userId,
    })
    .returning();
  // Pointer-only audit (the statement-connections creation idiom): the row
  // itself carries the reference for whoever is entitled to read it.
  await appendAudit({
    actorId: principal.userId,
    actorRole: principal.role,
    firmId,
    action: "collections.account_created",
    entityType: "collection_account",
    entityId: row.id,
    after: { clientPartyId: row.clientPartyId, provider: row.provider },
  });
  return row;
}

// The client's accounts, newest first. Callers hold statement.write and have
// already asserted party access; firm isolation is RLS at the data layer.
export async function listCollectionAccounts(
  clientPartyId: string,
): Promise<CollectionAccountRow[]> {
  return getDb()
    .select()
    .from(collectionAccountsTable)
    .where(eq(collectionAccountsTable.clientPartyId, clientPartyId))
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
  reference?: string | null;
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
          inArray(invoicesTable.status, [...BINDABLE_STATUSES]),
        ),
      )
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

    // Append-only settlement lineage: every delivery is one event row (a
    // replayed webhook records again — evidence, never an update); actorId
    // null marks the machine observer.
    const occurredAt = input.paidAt ? new Date(input.paidAt) : new Date();
    await getDb().insert(settlementEventsTable).values({
      invoiceId: invoice.id,
      source: "collection_account",
      amount: input.amount,
      paymentStatus: "paid",
      actorId: null,
      occurredAt,
    });

    // Mirror the buyer paid-flag branch exactly (routes/buyer.ts):
    // compare-and-set so a concurrent cancel/credit (or an earlier replay
    // that already settled) wins — the event stands as lineage but the
    // settled transition is skipped. A `submitted` receivable records the
    // event only (the state machine settles from stamped/confirmed).
    if (canTransition(invoice.status, "settled")) {
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
