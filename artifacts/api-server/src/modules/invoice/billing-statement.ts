// Monthly platform-billing statement (round-15): what MeridianIQ's own bill
// for a closed month is made of, shown to the firm that pays it. The
// vat-pack posture exactly — deterministic, computed on demand, nothing
// stored — pointed at the platform's two meters:
//  - invoice volume: accepted invoices bucketed by the LAGOS issue month with
//    an accepted submission attempt (vat-pack's predicate, so the billing
//    count can never disagree with the filing surfaces), plus the month's
//    submission-attempt traffic for context (Lagos month, the calendar those
//    clocks are enforced on);
//  - Clerk tokens: the inference ledger over the UTC month, the SAME boundary
//    budget.ts enforces the allowance on — deliberately NOT Lagos, and the
//    note says so, because a statement that used a different window than the
//    429 gate would "prove" the gate wrong at every month edge.
// The fee is tier config applied to the accepted count: base subscription +
// max(0, accepted − included) × overage price, 2dp numeric strings (kobo).
import { eq, sql } from "drizzle-orm";
import {
  getDb,
  billingTiersTable,
  firmSubscriptionsTable,
  type BillingTier,
} from "@workspace/db";
import { lagosDateString, lagosWindowSql } from "../../lib/lagos-time";
import { monthLabel } from "../clerk/client-statement";
import { closedLagosMonths, packMonthInvoicesSql } from "../clerk/vat-pack";
import { DomainError } from "../errors";

export interface BillingStatementTier {
  key: string;
  name: string;
  monthlyPrice: string;
  includedInvoices: number;
  overagePrice: string;
  // Null = the platform default allowance (CLERK_FIRM_MONTHLY_TOKENS env)
  // applies — surfaced as null rather than resolving the env here, mirroring
  // how budget.ts owns that fallback.
  clerkMonthlyTokens: number | null;
}

export interface BillingStatementUsage {
  acceptedInvoices: number;
  submissionAttempts: number;
  clerkTokens: number;
  clerkCalls: number;
  byPurpose: { purpose: string; tokens: number }[];
}

export interface BillingStatementFee {
  base: string;
  overageInvoices: number;
  overage: string;
  total: string;
}

export interface BillingStatement {
  monthStart: string;
  monthLabel: string;
  months: { value: string; label: string }[];
  tier: BillingStatementTier;
  usage: BillingStatementUsage;
  fee: BillingStatementFee;
  note: string;
}

// The tier the firm is billed on: subscription join, with the essential row
// as the no-subscription fallback. THE shared resolution — routes/console.ts
// imports this for revenue-share statements, so the two billing surfaces
// cannot disagree about which tier a firm is on.
export async function billingTierForFirm(firmId: string): Promise<BillingTier> {
  const [sub] = await getDb()
    .select()
    .from(firmSubscriptionsTable)
    .where(eq(firmSubscriptionsTable.firmId, firmId))
    .limit(1);
  if (sub) {
    const [tier] = await getDb()
      .select()
      .from(billingTiersTable)
      .where(eq(billingTiersTable.id, sub.tierId))
      .limit(1);
    if (tier) return tier;
  }
  const [fallback] = await getDb()
    .select()
    .from(billingTiersTable)
    .where(eq(billingTiersTable.key, "essential"))
    .limit(1);
  if (!fallback) {
    throw new DomainError("NO_TIER", "No billing tiers configured", 500);
  }
  return fallback;
}

// Pure fee maths, exported so the overage arithmetic is testable without a
// tier row in the database — and shared with routes/console.ts's revenue-share
// statements (which layer the share percentage on top of this fee core).
// 2dp strings (kobo), never floats in the output.
export function computeBillingFee(
  tier: Pick<BillingTier, "monthlyPrice" | "includedInvoices" | "overagePrice">,
  acceptedInvoices: number,
): BillingStatementFee {
  const overageInvoices = Math.max(
    0,
    acceptedInvoices - tier.includedInvoices,
  );
  const base = Number(tier.monthlyPrice);
  const overage = overageInvoices * Number(tier.overagePrice);
  return {
    base: base.toFixed(2),
    overageInvoices,
    overage: overage.toFixed(2),
    total: (base + overage).toFixed(2),
  };
}

export async function computeBillingStatement(
  firmId: string,
  monthStart: string,
): Promise<BillingStatement> {
  const db = getDb();
  const tier = await billingTierForFirm(firmId);

  // Accepted invoices: vat-pack's predicate exactly — the SHARED
  // packMonthInvoicesSql fragment (issue-month basis on the Lagos calendar,
  // cancelled excluded, an accepted attempt whenever it happened) — invoices
  // only, matching the pack's acceptedCount column by construction.
  const [accepted] = (
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM invoices i
      WHERE ${packMonthInvoicesSql(firmId, monthStart)}
    `)
  ).rows;

  // Submission-attempt traffic inside the Lagos month — context, not a fee
  // input. Same lagosWindowSql fragment every statutory bucketing shares.
  const [attempts] = (
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM submission_attempts sa
      JOIN invoices i ON i.id = sa.invoice_id
      WHERE i.firm_id = ${firmId}
        AND ${lagosWindowSql(sql`sa.created_at`, monthStart)}
    `)
  ).rows;

  // Clerk metering: the UTC month window, the same boundary budget.ts
  // enforces the token allowance on. One grouped query; totals are the sum of
  // the groups by construction, so the split can never disagree with them.
  const utcStart = new Date(`${monthStart}T00:00:00.000Z`);
  const utcEnd = new Date(
    Date.UTC(utcStart.getUTCFullYear(), utcStart.getUTCMonth() + 1, 1),
  );
  const purposeRows = (
    await db.execute<{ purpose: string; tokens: number; calls: number }>(sql`
      SELECT purpose,
        COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)::int AS tokens,
        COUNT(*)::int AS calls
      FROM clerk_inference_calls
      WHERE firm_id = ${firmId}
        AND created_at >= ${utcStart}
        AND created_at < ${utcEnd}
      GROUP BY purpose
      ORDER BY 2 DESC, purpose ASC
    `)
  ).rows;
  const byPurpose = purposeRows.map((r) => ({
    purpose: r.purpose,
    tokens: Number(r.tokens),
  }));
  const clerkTokens = purposeRows.reduce((s, r) => s + Number(r.tokens), 0);
  const clerkCalls = purposeRows.reduce((s, r) => s + Number(r.calls), 0);

  const acceptedInvoices = Number(accepted?.n ?? 0);
  const label = monthLabel(monthStart);
  return {
    monthStart,
    monthLabel: label,
    months: closedLagosMonths().map((value) => ({
      value,
      label: monthLabel(value),
    })),
    tier: {
      key: tier.key,
      name: tier.name,
      monthlyPrice: Number(tier.monthlyPrice).toFixed(2),
      includedInvoices: tier.includedInvoices,
      overagePrice: Number(tier.overagePrice).toFixed(2),
      clerkMonthlyTokens: tier.clerkMonthlyTokens,
    },
    usage: {
      acceptedInvoices,
      submissionAttempts: Number(attempts?.n ?? 0),
      clerkTokens,
      clerkCalls,
      byPurpose,
    },
    fee: computeBillingFee(tier, acceptedInvoices),
    note:
      `Platform billing statement for ${label}: fee = base subscription + max(0, accepted − included) × overage price on the ${tier.name} tier. ` +
      `Invoice counts use the Lagos calendar month (issue-month basis, accepted on the rails — the same predicate as the VAT pack); ` +
      `Clerk token metering uses the UTC month, mirroring how the budget gate enforces the allowance. ` +
      `Deterministic and computed on demand, nothing stored. Generated ${lagosDateString()}.`,
  };
}
