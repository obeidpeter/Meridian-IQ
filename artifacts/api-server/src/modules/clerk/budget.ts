import { and, eq, gte, sql } from "drizzle-orm";
import {
  getDb,
  billingTiersTable,
  clerkInferenceCallsTable,
  firmSubscriptionsTable,
} from "@workspace/db";
import { DomainError } from "../errors";

// Per-firm Clerk budget (Clerk expansion A). Client capture and firm Ask Clerk
// spend real model tokens, so each firm gets a monthly token allowance:
// the tier's clerk_monthly_tokens when set, else the platform default. The
// spend side is the inference ledger itself (every call is recorded there with
// the firm it was made for), so enforcement needs no separate counter and is
// exact even across instances. Budgets are measured in TOKENS, not USD —
// the USD rates are optional operator configuration, tokens are always known.
// Operator/platform traffic carries no firmId and is never capped.

const DEFAULT_MONTHLY_TOKENS = Number(
  process.env.CLERK_FIRM_MONTHLY_TOKENS ?? 2_000_000,
);

export interface FirmClerkUsage {
  monthStart: Date;
  usedTokens: number;
  budgetTokens: number;
}

export async function firmClerkUsage(firmId: string): Promise<FirmClerkUsage> {
  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  const [tier] = await getDb()
    .select({ clerkMonthlyTokens: billingTiersTable.clerkMonthlyTokens })
    .from(firmSubscriptionsTable)
    .innerJoin(
      billingTiersTable,
      eq(firmSubscriptionsTable.tierId, billingTiersTable.id),
    )
    .where(eq(firmSubscriptionsTable.firmId, firmId))
    .limit(1);

  const [used] = await getDb()
    .select({
      tokens: sql<number>`coalesce(sum(coalesce(${clerkInferenceCallsTable.promptTokens}, 0) + coalesce(${clerkInferenceCallsTable.completionTokens}, 0)), 0)`,
    })
    .from(clerkInferenceCallsTable)
    .where(
      and(
        eq(clerkInferenceCallsTable.firmId, firmId),
        gte(clerkInferenceCallsTable.createdAt, monthStart),
      ),
    );

  return {
    monthStart,
    usedTokens: Number(used?.tokens ?? 0),
    budgetTokens: tier?.clerkMonthlyTokens ?? DEFAULT_MONTHLY_TOKENS,
  };
}

// Gate for firm-attributed Clerk work. Called BEFORE the gateway/provider is
// touched, so an exhausted firm gets a clean 429 without any model call. The
// check is advisory-at-the-edge (a burst of parallel requests can each pass
// and overshoot by one call's tokens) — acceptable: the ceiling holds from the
// next request on, and the ledger keeps the true spend.
export async function assertFirmClerkBudget(firmId: string): Promise<void> {
  const usage = await firmClerkUsage(firmId);
  if (usage.usedTokens >= usage.budgetTokens) {
    throw new DomainError(
      "CLERK_BUDGET_EXHAUSTED",
      "Your firm has used its Clerk allowance for this month. Manual workflows are unaffected; contact MeridianIQ to raise the allowance.",
      429,
    );
  }
}
