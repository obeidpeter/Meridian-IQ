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

// Budget pace (exhaust idea #7): turn the 429 cliff into a heads-up. Pure and
// deterministic over the SAME UTC month boundary the enforcement uses, so the
// warning can never disagree with the gate. Bands:
//  - "critical": the allowance is spent (the next firm-attributed call 429s);
//  - "warning": 80% of the allowance is used, OR at least a quarter of the
//    month has elapsed and the current burn rate projects past the allowance
//    before month end (the early-heads-up case);
//  - "ok": everything else. Early-month noise is avoided by the 25% floor —
//    day-one spikes project absurdly and would train firms to ignore it.
export type BudgetPaceBand = "ok" | "warning" | "critical";

export const PACE_WARNING_USED_FRACTION = 0.8;
export const PACE_MIN_ELAPSED_FRACTION = 0.25;

export function budgetPace(
  usage: Pick<FirmClerkUsage, "monthStart" | "usedTokens" | "budgetTokens">,
  now: Date = new Date(),
): { projectedTokens: number; paceBand: BudgetPaceBand } {
  const monthStart = usage.monthStart.getTime();
  const monthEnd = Date.UTC(
    usage.monthStart.getUTCFullYear(),
    usage.monthStart.getUTCMonth() + 1,
    1,
  );
  const elapsed = Math.min(
    1,
    Math.max(0, (now.getTime() - monthStart) / (monthEnd - monthStart)),
  );
  // With nothing elapsed the projection is undefined; report the spend as-is.
  const projectedTokens =
    elapsed > 0 ? Math.round(usage.usedTokens / elapsed) : usage.usedTokens;

  if (usage.budgetTokens <= 0 || usage.usedTokens >= usage.budgetTokens) {
    return { projectedTokens, paceBand: "critical" };
  }
  if (
    usage.usedTokens >= usage.budgetTokens * PACE_WARNING_USED_FRACTION ||
    (elapsed >= PACE_MIN_ELAPSED_FRACTION && projectedTokens >= usage.budgetTokens)
  ) {
    return { projectedTokens, paceBand: "warning" };
  }
  return { projectedTokens, paceBand: "ok" };
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
