import { and, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  invoicesTable,
  firmsTable,
  revenueShareStatementsTable,
  type BillingTier,
} from "@workspace/db";
import { DomainError } from "../errors";
import {
  billingTierForFirm,
  computeBillingFee,
} from "../invoice/billing-statement";

// Revenue-share statement generation (PL-01), extracted from
// routes/console/billing.ts: the route keeps gating, the operator all-firms
// fan-out and the audit row; this module owns the billed-volume window, the
// share maths and the per-period upsert.

// Invoice statuses that count as processed volume for billing/overages.
const BILLED_STATUSES = [
  "submitted",
  "stamped",
  "confirmed",
  "settled",
] as const;

// --- Billing helpers --------------------------------------------------------
// Tier resolution AND the base+overage fee core are shared with the monthly
// platform-billing statement (modules/invoice/billing-statement.ts:
// billingTierForFirm / computeBillingFee), so the two billing surfaces cannot
// disagree about which tier a firm is on or what its fee is. This wrapper
// layers the revenue-share maths (statement-only concern) on top, rounded to
// two decimals (kobo) so statements and the unearned-income view reconcile to
// the naira.
function computeBilling(tier: BillingTier, billedInvoices: number) {
  const fee = computeBillingFee(tier, billedInvoices);
  const pct = Number(tier.revenueSharePct);
  const revenueShareAmount = Number(fee.total) * pct;
  return {
    includedInvoices: tier.includedInvoices,
    overageInvoices: fee.overageInvoices,
    subscriptionAmount: fee.base,
    overageAmount: fee.overage,
    billingAmount: fee.total,
    revenueSharePct: pct.toString(),
    revenueShareAmount: revenueShareAmount.toFixed(2),
  };
}

function periodBounds(period: string): { start: Date; end: Date } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    throw new DomainError("BAD_PERIOD", "Period must be YYYY-MM", 400);
  }
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start, end };
}

// Batched firm-name lookup (same idiom as caseViews): one query for the whole
// statement page, not one per firm. Missing firms simply have no entry.
export async function firmNamesById(
  firmIds: string[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(firmIds)];
  if (uniq.length === 0) return new Map();
  const firms = await getDb()
    .select({ id: firmsTable.id, name: firmsTable.name })
    .from(firmsTable)
    .where(inArray(firmsTable.id, uniq));
  return new Map(firms.map((f) => [f.id, f.name]));
}

export async function generateRevenueShareStatement(
  firmId: string,
  period: string,
) {
  const { start, end } = periodBounds(period);
  const tier = await billingTierForFirm(firmId);
  const [{ count }] = await getDb()
    .select({ count: sql<number>`count(*)::int` })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.firmId, firmId),
        inArray(invoicesTable.status, [...BILLED_STATUSES]),
        sql`${invoicesTable.issueDate} >= ${start.toISOString().slice(0, 10)}`,
        sql`${invoicesTable.issueDate} < ${end.toISOString().slice(0, 10)}`,
      ),
    );
  const billedInvoices = Number(count) || 0;
  const billing = computeBilling(tier, billedInvoices);
  const values = {
    firmId,
    period,
    tierKey: tier.key,
    billedInvoices,
    includedInvoices: billing.includedInvoices,
    overageInvoices: billing.overageInvoices,
    subscriptionAmount: billing.subscriptionAmount,
    overageAmount: billing.overageAmount,
    billingAmount: billing.billingAmount,
    revenueSharePct: billing.revenueSharePct,
    revenueShareAmount: billing.revenueShareAmount,
    breakdown: {
      tierName: tier.name,
      monthlyPrice: tier.monthlyPrice,
      overagePrice: tier.overagePrice,
    },
  };
  const [row] = await getDb()
    .insert(revenueShareStatementsTable)
    .values(values)
    .onConflictDoUpdate({
      target: [
        revenueShareStatementsTable.firmId,
        revenueShareStatementsTable.period,
      ],
      set: { ...values, generatedAt: new Date() },
    })
    .returning();
  return row;
}
