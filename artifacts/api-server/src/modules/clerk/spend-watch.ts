import { and, eq, sql } from "drizzle-orm";
import { getDb, runInBypassContext, auditEventsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { appendAudit } from "../audit/audit";
import { registerSweep } from "../pipeline/pipeline";

// Firm spend anomaly watch. The per-firm monthly budget is a hard monthly
// cap, and the platform spend meter is a chart someone has to look at — but a
// runaway integration, a scripted client or a stolen session can burn a
// month's tokens in a day while staying under every monthly line. This sweep
// compares each firm's LATEST day of ledger spend against that firm's own
// trailing baseline and raises a durable alert — an audit event plus an
// error-level log line — when a day spikes materially above it. Pure rules
// over the inference ledger: zero model calls, and like the resistance watch
// it takes no automatic action (a spend spike needs a human judgement — the
// budget, not this sweep, is the enforcement layer).
//
// Thresholds are env-tunable and deliberately need a real baseline: a firm
// with only a couple of measured days produces medians too noisy to alert on.

// A malformed value (empty string → 0, garbage → NaN) must never produce
// NaN comparisons or a permanently-silent watch — fall back to the default
// instead.
function envThreshold(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// The absolute floor keeps small firms quiet: 5× a tiny median is still tiny.
const MIN_TOKENS = envThreshold(process.env.SPEND_ALERT_MIN_TOKENS, 100_000);
const MULTIPLIER = envThreshold(process.env.SPEND_ALERT_MULTIPLIER, 5);
// A firm needs this many measured days BESIDES the latest before its median
// is a baseline worth trusting.
const MIN_BASELINE_DAYS = 3;

export const SPEND_ANOMALY_ACTION = "clerk.spend.anomaly";

export interface FirmSpendDay {
  firmId: string;
  day: string; // "YYYY-MM-DD" (UTC)
  tokens: number;
}

export interface SpendAnomaly {
  firmId: string;
  day: string; // the anomalous (latest measured) day
  tokens: number;
  medianTokens: number; // the firm's baseline over its other measured days
}

// Per-firm daily token totals over a trailing window, straight from the
// inference ledger. Firm-funded traffic only (firm_id NOT NULL — platform
// traffic has no budget owner to alert about); UTC days, the same boundary
// posture as the per-firm budgets, and the same token expression budget.ts
// charges, so the watch counts exactly what the budget counts.
export async function firmSpendDays(days = 15): Promise<FirmSpendDay[]> {
  const rows = (
    await getDb().execute<{ firm_id: string; day: string; tokens: number }>(sql`
      SELECT firm_id,
        to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
        SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0))::int AS tokens
      FROM clerk_inference_calls
      WHERE firm_id IS NOT NULL
        AND created_at >= date_trunc('day', now()) - make_interval(days => ${days})
      GROUP BY 1, 2
      ORDER BY 1, 2
    `)
  ).rows;
  return rows.map((r) => ({
    firmId: r.firm_id,
    day: r.day,
    tokens: Number(r.tokens),
  }));
}

// Even-length samples average the middle pair (the conventional median).
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Pure detection, exported for tests: per firm, the LATEST measured day is
// compared against the median of that firm's OTHER days in the window. Both
// gates must trip — the multiplier (materially above the firm's own habit)
// AND the absolute floor (a habit of near-zero makes any use look like a
// spike) — and a firm without a real baseline is skipped, not compared.
export function detectSpendAnomalies(rows: FirmSpendDay[]): SpendAnomaly[] {
  const byFirm = new Map<string, FirmSpendDay[]>();
  for (const row of rows) {
    const days = byFirm.get(row.firmId);
    if (days) days.push(row);
    else byFirm.set(row.firmId, [row]);
  }
  const anomalies: SpendAnomaly[] = [];
  for (const [firmId, days] of byFirm) {
    const sorted = [...days].sort((a, b) => a.day.localeCompare(b.day));
    const latest = sorted[sorted.length - 1];
    const baseline = sorted.slice(0, -1).map((d) => d.tokens);
    if (baseline.length < MIN_BASELINE_DAYS) continue;
    const medianTokens = median(baseline);
    if (latest.tokens < Math.max(MIN_TOKENS, MULTIPLIER * medianTokens)) {
      continue;
    }
    anomalies.push({
      firmId,
      day: latest.day,
      tokens: latest.tokens,
      medianTokens,
    });
  }
  return anomalies;
}

export interface SpendWatchResult {
  checked: boolean;
  anomalies: number; // anomalies currently detected
  alerted: number; // alerts actually appended (dedup skips the rest)
}

// The spend source is injectable so tests can exercise the alert/dedup logic
// without depending on whatever ledger rows other test files have stored (the
// same isolation trick as the resistance watch's ResistanceWatchDeps).
export interface SpendWatchDeps {
  spendDays: () => Promise<FirmSpendDay[]>;
}

const realDeps: SpendWatchDeps = { spendDays: firmSpendDays };

// One alert per (firm, day): the append-only audit ledger is the durable
// cross-instance dedup key (entity_id = "firmId:day"), fronted by an
// in-process cache so the day-long tail of a detected spike doesn't re-query
// the ledger every sweep minute. Two instances FIRST detecting the same spike
// simultaneously can, in the worst case, both append (the audit advisory lock
// serializes the appends, not the check-then-append) — a harmless duplicate
// history row, accepted rather than adding a lock.
const alertedFirmDays = new Set<string>();

export async function sweepSpendWatch(
  deps: SpendWatchDeps = realDeps,
): Promise<SpendWatchResult> {
  return runInBypassContext(async () => {
    const anomalies = detectSpendAnomalies(await deps.spendDays());
    let alerted = 0;
    for (const anomaly of anomalies) {
      const key = `${anomaly.firmId}:${anomaly.day}`;
      if (alertedFirmDays.has(key)) continue;

      const [existing] = await getDb()
        .select({ seq: auditEventsTable.seq })
        .from(auditEventsTable)
        .where(
          and(
            eq(auditEventsTable.action, SPEND_ANOMALY_ACTION),
            eq(auditEventsTable.entityId, key),
          ),
        )
        .limit(1);
      if (existing) {
        alertedFirmDays.add(key);
        continue;
      }

      await appendAudit({
        actorId: "spend-watch",
        actorRole: "system",
        action: SPEND_ANOMALY_ACTION,
        entityType: "clerk_spend",
        entityId: key,
        after: {
          firmId: anomaly.firmId,
          day: anomaly.day,
          tokens: anomaly.tokens,
          medianTokens: anomaly.medianTokens,
          reason:
            "The firm's latest-day Clerk token spend spiked materially above its own trailing baseline; review the firm's ledger traffic before the monthly budget absorbs it.",
        },
      });
      logger.error(
        { ...anomaly },
        "Firm Clerk spend SPIKED above its own baseline: review the firm's inference traffic (runaway integration, scripted client or compromised session) on the Clerk health page.",
      );
      alertedFirmDays.add(key);
      alerted += 1;
    }
    return { checked: true, anomalies: anomalies.length, alerted };
  });
}

registerSweep(sweepSpendWatch);
