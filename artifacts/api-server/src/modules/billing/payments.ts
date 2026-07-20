import { and, desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  paymentIntentsTable,
  type PaymentIntent,
} from "@workspace/db";
import { computeBillingStatement } from "../invoice/billing-statement";
import { closedLagosMonths } from "../clerk/vat-pack";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import type { Principal } from "../auth/rbac";
import { initProviderPayment } from "./provider";

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

// Walk err → cause for Postgres' unique-violation SQLSTATE. Drizzle's
// node-postgres driver rethrows the pg error, but wrap-layers may nest it —
// same defensive chain-walk as rls-isolation's isRlsViolation.
function isUniqueViolation(err: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { code?: string; cause?: unknown };
    if (e.code === "23505") return true;
    cur = e.cause;
  }
  return false;
}

const LIVE_STATUSES = ["pending", "confirmed"] as const;

export async function createPaymentIntent(
  firmId: string,
  monthStart: string,
  actor: Principal,
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

  // The EXISTING fee core: tier + metered usage → base + overage, 2dp naira.
  const statement = await computeBillingStatement(firmId, monthStart);
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
  const [live] = await getDb()
    .select({ id: paymentIntentsTable.id })
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
    throw new DomainError(
      "DUPLICATE_INTENT",
      `A live payment intent already exists for ${statement.monthLabel}`,
      409,
    );
  }

  const init = await initProviderPayment({ firmId, monthStart, amountNgn });

  let row: PaymentIntent;
  try {
    [row] = await getDb()
      .insert(paymentIntentsTable)
      .values({
        firmId,
        monthStart,
        amountNgn,
        status: "pending",
        providerRef: init.providerRef,
        checkoutUrl: init.checkoutUrl,
      })
      .returning();
  } catch (err) {
    // A concurrent create lost the race to the one-live-intent index: the
    // same 409 the pre-check gives. The 4xx rollback rule unwinds this
    // request's work; the survivor's intent stands.
    if (isUniqueViolation(err)) {
      throw new DomainError(
        "DUPLICATE_INTENT",
        `A live payment intent already exists for ${statement.monthLabel}`,
        409,
      );
    }
    throw err;
  }

  // Pointer-only audit (never amounts): the intent row itself carries the
  // figures for whoever is entitled to read them.
  await appendAudit({
    actorId: actor.userId,
    actorRole: actor.role,
    firmId,
    action: "billing.payment_intent.created",
    entityType: "payment_intent",
    entityId: row.id,
    after: { status: row.status, monthStart: row.monthStart },
  });
  return row;
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
