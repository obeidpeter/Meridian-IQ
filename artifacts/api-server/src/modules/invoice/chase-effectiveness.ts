import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { lagosDateString } from "../../lib/lagos-time";
import { median } from "./payment-behaviour";

// Reminder-effectiveness report (round-16 idea #2). The chase ladder records
// which reminders were SENT; the settlement exhaust records when money
// ARRIVED. Joining them answers the client's real question — does chasing
// work? — with the same exhaust-audits-the-exhaust posture as projection
// accuracy. Zero model calls, computed on demand, nothing stored.
//
// Honesty notes, pinned:
//  - this is CORRELATION: buyers who get reminded differ from buyers who
//    don't (that's why they were reminded) — the note says so;
//  - the within-14-days share only counts MATURE reminders (first reminder
//    at least 14 days old, or already settled), so fresh reminders can't
//    deflate the share before their window has run;
//  - "settled" is observed payment evidence (paid flag or statement match),
//    and a settlement BEFORE the first reminder never credits the reminder.

const LOOKBACK_DAYS = 365;
const WITHIN_DAYS = 14;
const MIN_SAMPLE = 3;

export interface ChaseOutcomeRow {
  issueDate: string;
  firstReminderAt: string | null;
  reminders: number;
  settledAt: string | null;
}

export interface ChaseEffectiveness {
  asOf: string;
  withinDays: number;
  remindedCount: number;
  remindedSettledCount: number;
  // Among mature reminded invoices: settled within WITHIN_DAYS of the first
  // reminder. Null under the sample floor.
  settledWithinShare: number | null;
  medianDaysReminderToSettle: number | null;
  // Issue-to-settlement medians, reminded vs unreminded settled invoices —
  // the comparison the caveat applies to hardest.
  medianDaysToSettleReminded: number | null;
  medianDaysToSettleUnreminded: number | null;
  note: string;
}

function daysBetweenTs(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

// Pure summary over per-invoice outcome rows, exported for tests.
export function summarizeChaseEffectiveness(
  rows: ChaseOutcomeRow[],
  asOf: string,
): ChaseEffectiveness {
  const reminded = rows.filter((r) => r.reminders > 0 && r.firstReminderAt);
  // A settlement observed BEFORE the first reminder never credits it.
  const remindedSettled = reminded.filter(
    (r) =>
      r.settledAt !== null && r.settledAt > (r.firstReminderAt as string),
  );
  // End of the Lagos day (asOf is a Lagos date string).
  const nowMs = new Date(`${asOf}T23:59:59+01:00`).getTime();
  // The share's denominator: reminders whose window has RUN — settled after
  // the reminder, or unsettled with the window elapsed. An invoice already
  // settled when its reminder went out had no window at all, so it belongs
  // in neither side of the share.
  const mature = reminded.filter(
    (r) =>
      (r.settledAt !== null && r.settledAt > (r.firstReminderAt as string)) ||
      (r.settledAt === null &&
        nowMs - new Date(r.firstReminderAt as string).getTime() >=
          WITHIN_DAYS * 86_400_000),
  );
  const withinCount = remindedSettled.filter(
    (r) =>
      daysBetweenTs(r.firstReminderAt as string, r.settledAt as string) <=
      WITHIN_DAYS,
  ).length;

  const reminderToSettle = remindedSettled.map((r) =>
    daysBetweenTs(r.firstReminderAt as string, r.settledAt as string),
  );
  const issueToSettle = (list: ChaseOutcomeRow[]) =>
    list
      .filter((r) => r.settledAt !== null)
      .map((r) => daysBetweenTs(`${r.issueDate}T00:00:00Z`, r.settledAt as string));
  const remindedDays = issueToSettle(reminded);
  const unremindedDays = issueToSettle(rows.filter((r) => r.reminders === 0));

  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    asOf,
    withinDays: WITHIN_DAYS,
    remindedCount: reminded.length,
    remindedSettledCount: remindedSettled.length,
    settledWithinShare:
      mature.length >= MIN_SAMPLE
        ? Math.round((withinCount / mature.length) * 10000) / 10000
        : null,
    medianDaysReminderToSettle:
      reminderToSettle.length >= MIN_SAMPLE
        ? round1(median(reminderToSettle))
        : null,
    medianDaysToSettleReminded:
      remindedDays.length >= MIN_SAMPLE ? round1(median(remindedDays)) : null,
    medianDaysToSettleUnreminded:
      unremindedDays.length >= MIN_SAMPLE
        ? round1(median(unremindedDays))
        : null,
    note:
      `Reminders logged on the chase ladder joined to observed payment evidence over the trailing year. ` +
      `This is correlation, not causation — reminded invoices were reminded BECAUSE they were late, so comparing them with unreminded ones understates the reminder's effect. ` +
      `The within-${WITHIN_DAYS}-day share counts only reminders old enough for their window to have run.`,
  };
}

export async function computeChaseEffectiveness(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<ChaseEffectiveness> {
  const since = lagosDateString(
    new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000),
  );
  const rows = (
    await getDb().execute<{
      issue_date: string;
      first_reminder_at: string | null;
      reminders: number;
      settled_at: string | null;
    }>(sql`
      SELECT
        i.issue_date::text AS issue_date,
        (SELECT MIN(c.created_at) FROM chase_log c
          WHERE c.invoice_id = i.id)::text AS first_reminder_at,
        (SELECT COUNT(*) FROM chase_log c
          WHERE c.invoice_id = i.id)::int AS reminders,
        (SELECT MIN(se.occurred_at) FROM settlement_events se
          WHERE se.invoice_id = i.id
            AND (se.payment_status = 'paid' OR se.source = 'statement_match')
        )::text AS settled_at
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
        AND i.kind = 'invoice'
        AND i.status IN ('submitted', 'stamped', 'confirmed', 'settled')
        AND i.issue_date >= ${since}
      LIMIT 50000
    `)
  ).rows;
  return summarizeChaseEffectiveness(
    rows.map((r) => ({
      issueDate: r.issue_date,
      firstReminderAt: r.first_reminder_at
        ? new Date(r.first_reminder_at).toISOString()
        : null,
      reminders: Number(r.reminders),
      settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    })),
    lagosDateString(now),
  );
}
