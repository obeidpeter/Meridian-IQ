import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  runRequestContext,
  paymentIntentsTable,
  type PaymentIntent,
} from "@workspace/db";
import { computeBillingStatement } from "../invoice/billing-statement";
import { closedLagosMonths } from "../clerk/vat-pack";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import type { Principal } from "../auth/rbac";
import { initProviderPayment } from "./provider";
import { withProviderOperationLock } from "../../lib/provider-operation-lock";

// Payment collection seam (Paystack-shaped, dark by default): a firm pays the
// platform bill the billing statement already shows it. The amount is NEVER a
// caller input — it is computed from the SAME computeBillingStatement fee
// core the statement surface renders (so what the firm pays can never
// disagree with what the firm was shown), frozen onto the intent row, and
// handed to the injectable provider seam (provider.ts — simulator unless
// PAYMENT_PROVIDER_URL lights a relay). Settlement arrives ONLY through the
// off-contract confirmation webhook (routes/billing-payments.ts) as a
// pending→confirmed/failed CAS; the partial unique index
// (payment_intents_one_live_per_month) is the duplicate-payment wall.

const LIVE_STATUSES = ["pending", "confirmed"] as const;

export async function createPaymentIntent(
  firmId: string,
  monthStart: string,
  actor: Principal,
  signal?: AbortSignal,
): Promise<PaymentIntent> {
  // Closed-month discipline (the resolveClosedPeriod idiom): only a month on
  // the billing statement's own option list can be paid — the fee for an
  // OPEN month is still moving. The contract requires monthStart, so there
  // is no newest-closed default here.
  if (!closedLagosMonths().includes(monthStart)) {
    throw new DomainError(
      "BAD_MONTH",
      "month must be one of the last 12 closed Lagos months (YYYY-MM-01)",
      400,
    );
  }

  return withProviderOperationLock(
    `billing:${firmId}:${monthStart}`,
    async () => {
      // The EXISTING fee core: tier + metered usage → base + overage, 2dp naira.
      const inFirmScope = <T>(fn: () => Promise<T>) =>
        runRequestContext({ bypass: false, firmId }, fn);
      const statement = await inFirmScope(() =>
        computeBillingStatement(firmId, monthStart),
      );
      const amountNgn = statement.fee.total;
      if (!(Number(amountNgn) > 0)) {
        throw new DomainError(
          "ZERO_FEE",
          `Nothing to collect for ${statement.monthLabel}: the computed fee is ${amountNgn}`,
          400,
        );
      }

      // Friendly duplicate refusal BEFORE the provider is involved, so the
      // common case never mints an orphan provider reference. The partial
      // unique index below remains the race-proof wall.
      const reservation = await inFirmScope(async () => {
        const [history] = await getDb()
          .select({ count: sql<number>`count(*)::int` })
          .from(paymentIntentsTable)
          .where(
            and(
              eq(paymentIntentsTable.firmId, firmId),
              eq(paymentIntentsTable.monthStart, monthStart),
            ),
          );
        const priorCount = Number(history?.count ?? 0);
        const [live] = await getDb()
          .select()
          .from(paymentIntentsTable)
          .where(
            and(
              eq(paymentIntentsTable.firmId, firmId),
              eq(paymentIntentsTable.monthStart, monthStart),
              inArray(paymentIntentsTable.status, [...LIVE_STATUSES]),
            ),
          )
          .limit(1);
        if (live) {
          if (live.status === "pending" && live.providerRef === null) {
            // The reservation freezes the provider payload. Repricing a retry
            // under the same idempotency key could make a provider return an old
            // transaction for a new amount or reject the request as conflicting.
            return { row: live, attemptNo: priorCount };
          }
          throw new DomainError(
            "DUPLICATE_INTENT",
            `A live payment intent already exists for ${statement.monthLabel}`,
            409,
          );
        }

        const [created] = await getDb()
          .insert(paymentIntentsTable)
          .values({
            firmId,
            monthStart,
            amountNgn,
            status: "pending",
            providerRef: null,
            checkoutUrl: null,
          })
          .onConflictDoNothing()
          .returning();
        if (created) return { row: created, attemptNo: priorCount + 1 };
        const [winner] = await getDb()
          .select()
          .from(paymentIntentsTable)
          .where(
            and(
              eq(paymentIntentsTable.firmId, firmId),
              eq(paymentIntentsTable.monthStart, monthStart),
              inArray(paymentIntentsTable.status, [...LIVE_STATUSES]),
            ),
          )
          .limit(1);
        if (winner?.status === "pending" && winner.providerRef === null) {
          return { row: winner, attemptNo: priorCount + 1 };
        }
        throw new DomainError(
          "DUPLICATE_INTENT",
          `A live payment intent already exists for ${statement.monthLabel}`,
          409,
        );
      });

      const init = await initProviderPayment(
        {
          firmId,
          monthStart,
          amountNgn: reservation.row.amountNgn,
          idempotencyKey: `billing:${firmId}:${monthStart}:${reservation.attemptNo}`,
        },
        signal,
      );
      return inFirmScope(async () => {
        const [finalized] = await getDb()
          .update(paymentIntentsTable)
          .set({
            providerRef: init.providerRef,
            checkoutUrl: init.checkoutUrl,
          })
          .where(
            and(
              eq(paymentIntentsTable.id, reservation.row.id),
              eq(paymentIntentsTable.status, "pending"),
              isNull(paymentIntentsTable.providerRef),
            ),
          )
          .returning();
        if (!finalized) {
          const [current] = await getDb()
            .select()
            .from(paymentIntentsTable)
            .where(eq(paymentIntentsTable.id, reservation.row.id))
            .limit(1);
          if (current?.providerRef) return current;
          throw new DomainError(
            "PAYMENT_RESERVATION_LOST",
            "Payment reservation is no longer available",
            409,
          );
        }

        // Pointer-only audit (never amounts): the intent row itself carries the
        // figures for whoever is entitled to read them.
        await appendAudit({
          actorId: actor.userId,
          actorRole: actor.role,
          firmId,
          action: "billing.payment_intent.created",
          entityType: "payment_intent",
          entityId: finalized.id,
          after: { status: finalized.status, monthStart: finalized.monthStart },
        });
        return finalized;
      });
    },
  );
}

// The firm's intents, newest first. Bounded far above any realistic history
// (12 payable months; dead attempts accumulate slowly).
export async function listPaymentIntents(
  firmId: string,
): Promise<PaymentIntent[]> {
  return getDb()
    .select()
    .from(paymentIntentsTable)
    .where(eq(paymentIntentsTable.firmId, firmId))
    .orderBy(desc(paymentIntentsTable.createdAt))
    .limit(200);
}

// Settle an intent from the provider's confirmation webhook. Runs on a
// NO_CONTEXT route (app.ts), so it opens its OWN short bypass transaction —
// the machine caller has no tenant, exactly the pipeline worker's posture —
// and the CAS + audit commit together. Compare-and-set on status: only a
// PENDING intent moves, so a replayed (or duplicate-delivered) confirmation
// matches zero rows and settles nothing twice; an unknown providerRef looks
// identical to a replay by design (the route answers 202 either way — the
// webhook must not be an oracle for guessing live references).
export async function confirmPaymentIntent(
  providerRef: string,
  outcome: "confirmed" | "failed",
): Promise<{ applied: boolean }> {
  return runInBypassContext(async () => {
    const [row] = await getDb()
      .update(paymentIntentsTable)
      .set({
        status: outcome,
        // confirmedAt records when the money was confirmed; a failure leaves
        // it null (the status is the record of the failure).
        ...(outcome === "confirmed" ? { confirmedAt: new Date() } : {}),
      })
      .where(
        and(
          eq(paymentIntentsTable.providerRef, providerRef),
          eq(paymentIntentsTable.status, "pending"),
        ),
      )
      .returning();
    if (!row) return { applied: false };

    // Reconcile onto the subscription: firm_subscriptions carries NO
    // paid-through or dunning notion — its status (active|paused|cancelled)
    // is the operator-managed subscription lifecycle, not payment state — so
    // a confirmed payment records the durable audit event below and touches
    // nothing else. Subscription state stays operator-managed by design;
    // inventing payment-driven semantics here would put two owners on one
    // column.
    await appendAudit({
      firmId: row.firmId,
      action: `billing.payment_intent.${outcome}`,
      entityType: "payment_intent",
      entityId: row.id,
      // Pointer-only: no amounts, no provider payload — the row has them.
      after: { status: outcome, monthStart: row.monthStart },
    });
    return { applied: true };
  });
}
