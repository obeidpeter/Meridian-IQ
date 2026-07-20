import { sql } from "drizzle-orm";
import { getDb, runInBypassContext } from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { alertOnceViaAuditLedger, atMostHourly, envThreshold } from "./watch-shared";

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
// traffic has no budget owner to alert about); UTC days pinned explicitly
// (`AT TIME ZONE 'UTC'` — bare date_trunc on a timestamptz follows the
// SESSION timezone, not UTC), the same boundary posture as the per-firm
// budgets, and the same token expression budget.ts charges, so the watch
// counts exactly what the budget counts.
export async function firmSpendDays(days = 15): Promise<FirmSpendDay[]> {
  const rows = (
    await getDb().execute<{ firm_id: string; day: string; tokens: number }>(sql`
      SELECT firm_id,
        to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
        SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0))::int AS tokens
      FROM clerk_inference_calls
      WHERE firm_id IS NOT NULL
        AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') - make_interval(days => ${days})) AT TIME ZONE 'UTC'
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

// One alert per (firm, day): entity_id = "firmId:day"; dedup discipline in
// alertOnceViaAuditLedger (audit ledger as the durable cross-instance key,
// in-process cache in front).
const alertSpendAnomaly = alertOnceViaAuditLedger({
  action: SPEND_ANOMALY_ACTION,
  entityType: "clerk_spend",
  actorId: "spend-watch",
});

export async function sweepSpendWatch(
  deps: SpendWatchDeps = realDeps,
): Promise<SpendWatchResult> {
  return runInBypassContext(async () => {
    const anomalies = detectSpendAnomalies(await deps.spendDays());
    let alerted = 0;
    for (const anomaly of anomalies) {
      const appended = await alertSpendAnomaly(
        `${anomaly.firmId}:${anomaly.day}`,
        {
          firmId: anomaly.firmId,
          day: anomaly.day,
          tokens: anomaly.tokens,
          medianTokens: anomaly.medianTokens,
          reason:
            "The firm's latest-day Clerk token spend spiked materially above its own trailing baseline; review the firm's ledger traffic before the monthly budget absorbs it.",
        },
        "Firm Clerk spend SPIKED above its own baseline: review the firm's inference traffic (runaway integration, scripted client or compromised session) on the Clerk health page.",
      );
      if (appended) alerted += 1;
    }
    return { checked: true, anomalies: anomalies.length, alerted };
  });
}

registerSweep(atMostHourly(sweepSpendWatch));
