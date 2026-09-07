import { and, desc, eq, gte, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  getDb,
  hasDatabaseContext,
  runRequestContext,
  pool,
  type PoolClient,
  billingTiersTable,
  clerkInferenceCallsTable,
  firmSubscriptionsTable,
} from "@workspace/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { DomainError } from "../errors";
import { clerkAdmissionRejected } from "../../lib/metrics";

// Per-firm Clerk budget (Clerk expansion A). Client capture and firm Ask Clerk
// spend real model tokens, so each firm gets a monthly token allowance:
// the tier's clerk_monthly_tokens when set, else the platform default. The
// spend side is the inference ledger itself (every call is recorded there with
// the firm it was made for), so enforcement needs no separate counter and is
// exact even across instances. Budgets are measured in TOKENS, not USD —
// the USD rates are optional operator configuration, tokens are always known.
// Operator/platform traffic carries no firmId and is never capped.

const configuredDefaultMonthlyTokens = Number(
  process.env.CLERK_FIRM_MONTHLY_TOKENS ?? 2_000_000,
);
const DEFAULT_MONTHLY_TOKENS =
  Number.isSafeInteger(configuredDefaultMonthlyTokens) &&
  configuredDefaultMonthlyTokens >= 0
    ? configuredDefaultMonthlyTokens
    : 2_000_000;

// THE token expression — what a call costs. One home (round 54): the spend
// watch, tier report, platform spend meter and billing statement all promise
// "the same token expression budget.ts charges", and the promise has already
// been broken once (tier-report's ::int cast overflowed int4 on a busy
// 90-day window, round 51). Two spellings for the two query styles; keep
// casts at the call site — and prefer ::bigint on wide windows.
export const LEDGER_TOKENS_SQL =
  "COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)";
// The Drizzle-typed aggregate the budget reads use directly.
const ledgerTokensSum = () =>
  sql<number>`coalesce(sum(coalesce(${clerkInferenceCallsTable.promptTokens}, 0) + coalesce(${clerkInferenceCallsTable.completionTokens}, 0)), 0)`;

// The UTC month boundary the token allowance is enforced on — every surface
// that meters Clerk spend must bucket on this exact Date.
export function utcMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// The linear month-pace rule shared by budgetPace and the platform spend
// meter (metrics.ts) — two comments used to promise the copies stayed the
// same; now there is one body. With nothing elapsed the projection is
// undefined; report the total as-is.
export function monthPace(
  monthStart: Date,
  total: number,
  now: Date,
): { elapsed: number; projected: number } {
  const startMs = monthStart.getTime();
  const endMs = Date.UTC(
    monthStart.getUTCFullYear(),
    monthStart.getUTCMonth() + 1,
    1,
  );
  const elapsed = Math.min(
    1,
    Math.max(0, (now.getTime() - startMs) / (endMs - startMs)),
  );
  return {
    elapsed,
    projected: elapsed > 0 ? Math.round(total / elapsed) : total,
  };
}

export interface FirmClerkUsage {
  monthStart: Date;
  usedTokens: number;
  budgetTokens: number;
}

export async function firmClerkUsage(firmId: string): Promise<FirmClerkUsage> {
  if (!hasDatabaseContext())
    return runRequestContext({ bypass: false, firmId }, () =>
      firmClerkUsage(firmId),
    );
  const monthStart = utcMonthStart();

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
      tokens: ledgerTokensSum(),
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

// Month-to-date spend split by ledger purpose — WHICH feature is consuming
// the allowance, for the usage meter's breakdown. Same ledger, same firm
// filter and the same month window as firmClerkUsage (the caller passes that
// call's monthStart so the two reads can never straddle a month boundary);
// heaviest purpose first. The purpose totals sum to usedTokens by
// construction — one table, one predicate, grouped.
export async function firmClerkUsageByPurpose(
  firmId: string,
  monthStart: Date,
): Promise<{ purpose: string; tokens: number }[]> {
  const tokens = ledgerTokensSum();
  const rows = await getDb()
    .select({ purpose: clerkInferenceCallsTable.purpose, tokens })
    .from(clerkInferenceCallsTable)
    .where(
      and(
        eq(clerkInferenceCallsTable.firmId, firmId),
        gte(clerkInferenceCallsTable.createdAt, monthStart),
      ),
    )
    .groupBy(clerkInferenceCallsTable.purpose)
    .orderBy(desc(tokens), clerkInferenceCallsTable.purpose);
  return rows.map((r) => ({ purpose: r.purpose, tokens: Number(r.tokens) }));
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

const PACE_WARNING_USED_FRACTION = 0.8;
const PACE_MIN_ELAPSED_FRACTION = 0.25;

export function budgetPace(
  usage: Pick<FirmClerkUsage, "monthStart" | "usedTokens" | "budgetTokens">,
  now: Date = new Date(),
): { projectedTokens: number; paceBand: BudgetPaceBand } {
  const { elapsed, projected: projectedTokens } = monthPace(
    usage.monthStart,
    usage.usedTokens,
    now,
  );

  if (usage.budgetTokens <= 0 || usage.usedTokens >= usage.budgetTokens) {
    return { projectedTokens, paceBand: "critical" };
  }
  if (
    usage.usedTokens >= usage.budgetTokens * PACE_WARNING_USED_FRACTION ||
    (elapsed >= PACE_MIN_ELAPSED_FRACTION &&
      projectedTokens >= usage.budgetTokens)
  ) {
    return { projectedTokens, paceBand: "warning" };
  }
  return { projectedTokens, paceBand: "ok" };
}

// Gate for firm-attributed Clerk work. Called BEFORE the gateway/provider is
// touched, so an exhausted firm gets a clean early 429. The gateway separately
// acquires a durable reservation under a short advisory transaction lock; no
// budget connection or transaction remains open across the provider call.
export async function assertFirmClerkBudget(firmId: string): Promise<void> {
  const usage = await firmClerkUsage(firmId);
  if (usage.usedTokens >= usage.budgetTokens) {
    throw new DomainError(
      "CLERK_BUDGET_EXHAUSTED",
      "Your firm has used its Clerk allowance for this month. Manual workflows are unaffected; contact Valo to raise the allowance.",
      429,
    );
  }
}

export interface FirmClerkBudgetPermit {
  append(row: typeof clerkInferenceCallsTable.$inferInsert): Promise<void>;
  release(): Promise<void>;
}

const admittedFirms = new Set<string>();
export function clerkFirmHasActivePermit(firmId: string): boolean {
  return admittedFirms.has(firmId);
}
// Pre-pool admission is fail-fast, not an unbounded queue of checked-out clients.
export function clerkAdmissionLimit(): number {
  return Math.max(1, Math.min(4, Math.floor((pool.options.max ?? 20) / 4)));
}

function busy(reason: "concurrency" | "unsettled" | "lock"): never {
  clerkAdmissionRejected.inc({ reason });
  throw new DomainError(
    "CLERK_BUSY",
    "Clerk is busy or awaiting spend reconciliation. Retry later; manual workflows are unaffected.",
    429,
  );
}

async function budgetTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE meridian_app");
    await client.query("SELECT set_config('app.bypass', 'on', true)");
    // These independent transactions must not wait behind provider work or an
    // ambient request. Server deadlines also bound COMMIT/ROLLBACK sequencing.
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '3000ms'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      releaseError =
        rollbackError instanceof Error
          ? rollbackError
          : new Error("Clerk rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function acquireFirmClerkBudgetPermit(
  firmId: string,
  reserveTokens: number,
): Promise<FirmClerkBudgetPermit | null> {
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 1) {
    throw new Error("Clerk reservation must be a positive safe integer");
  }
  if (admittedFirms.has(firmId) || admittedFirms.size >= clerkAdmissionLimit())
    busy("concurrency");
  admittedFirms.add(firmId);
  const reservationId = randomUUID();
  try {
    const admitted = await budgetTransaction(async (client) => {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS acquired",
        [`clerk-budget:${firmId}`],
      );
      if (!lock.rows[0]?.acquired) busy("lock");
      const pending = await client.query(
        "SELECT id FROM clerk_reservations WHERE firm_id = $1 AND settled_at IS NULL LIMIT 1",
        [firmId],
      );
      // An expired reservation is uncertain spend, not free allowance. Keep the
      // firm serialized across instances and restarts until it is reconciled.
      if (pending.rowCount) busy("unsettled");
      const tier = await client.query<{ clerk_monthly_tokens: number | null }>(
        `SELECT bt.clerk_monthly_tokens
         FROM firm_subscriptions fs
         JOIN billing_tiers bt ON bt.id = fs.tier_id
        WHERE fs.firm_id = $1
        LIMIT 1`,
        [firmId],
      );
      const used = await client.query<{ tokens: string }>(
        `SELECT COALESCE(sum(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0)::text AS tokens
         FROM clerk_inference_calls
        WHERE firm_id = $1
          AND created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`,
        [firmId],
      );
      const budget = Number(
        tier.rows[0]?.clerk_monthly_tokens ?? DEFAULT_MONTHLY_TOKENS,
      );
      const spent = Number(used.rows[0]?.tokens ?? 0);
      if (budget <= 0 || spent + reserveTokens > budget) {
        clerkAdmissionRejected.inc({ reason: "budget" });
        return false;
      }
      await client.query(
        `INSERT INTO clerk_reservations (id, firm_id, reserved_tokens, month_start, expires_at)
      VALUES ($1, $2, $3, date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC', now() + interval '5 minutes')`,
        [reservationId, firmId, reserveTokens],
      );
      return true;
    });
    if (!admitted) {
      admittedFirms.delete(firmId);
      return null;
    }
    let released = false;
    let settlement: Promise<void> | undefined;
    return {
      append(row): Promise<void> {
        if (released)
          return Promise.reject(new Error("Clerk permit already released"));
        if (row.firmId !== firmId)
          return Promise.reject(new Error("Clerk permit firm mismatch"));
        for (const value of [
          row.promptTokens ?? 0,
          row.completionTokens ?? 0,
        ]) {
          if (!Number.isSafeInteger(value) || value < 0)
            return Promise.reject(
              new Error("Invalid Clerk provider token usage"),
            );
        }
        // A second settlement (including an embedding catch after a DB error)
        // must not append another row or replace uncertain spend with a refund.
        settlement ??= budgetTransaction(async (client) => {
          const existing = await client.query<{
            inference_call_id: string | null;
            provider_call_id: string | null;
          }>(
            "SELECT inference_call_id, provider_call_id FROM clerk_reservations WHERE id = $1 FOR UPDATE",
            [reservationId],
          );
          if (!existing.rows[0]) throw new Error("Clerk reservation missing");
          if (existing.rows[0].provider_call_id) return;
          let charge = row;
          if (existing.rows[0].inference_call_id) {
            const previous = await client.query<{ tokens: string }>(
              "SELECT CASE WHEN created_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') THEN (COALESCE(prompt_tokens, 0)::bigint + COALESCE(completion_tokens, 0)) ELSE 0 END::text AS tokens FROM clerk_inference_calls WHERE id = $1",
              [existing.rows[0].inference_call_id],
            );
            const actual =
              (row.promptTokens ?? 0) + (row.completionTokens ?? 0);
            // An operator has already charged the uncertain reservation. A late
            // provider result adds only an excess, never refunds or double-charges.
            charge = {
              ...row,
              promptTokens: Math.max(
                0,
                actual - Number(previous.rows[0]?.tokens ?? 0),
              ),
              completionTokens: 0,
              errorText:
                `Late provider usage after reservation recovery: prompt=${row.promptTokens ?? 0}, completion=${row.completionTokens ?? 0}. ${row.errorText ?? ""}`.slice(
                  0,
                  2_000,
                ),
            };
          }
          const [call] = await drizzle(client)
            .insert(clerkInferenceCallsTable)
            .values(charge)
            .returning({ id: clerkInferenceCallsTable.id });
          await client.query(
            "UPDATE clerk_reservations SET settled_at = COALESCE(settled_at, now()), inference_call_id = COALESCE(inference_call_id, $2), provider_call_id = $2 WHERE id = $1",
            [reservationId, call.id],
          );
        });
        return settlement;
      },
      async release(): Promise<void> {
        if (released) return;
        released = true;
        admittedFirms.delete(firmId);
      },
    };
  } catch (err) {
    admittedFirms.delete(firmId);
    throw err;
  }
}
