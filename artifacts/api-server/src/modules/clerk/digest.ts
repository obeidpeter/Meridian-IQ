import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  getDb,
  runInBypassContext,
  clerkDigestsTable,
  firmsTable,
  membershipsTable,
  staffNotificationPreferencesTable,
  type ClerkDigestRow,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { sendMessage } from "../messaging/messaging";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { sendPushToUser } from "../push/push";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { lagosTodaySql } from "../../lib/lagos-time";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
import { countFirmUnbilled } from "../invoice/unbilled-income";
import { firmMoneySummary } from "../invoice/cashflow";
import { countFirmUnmatchedCredits } from "../invoice/unmatched-credits";
import { countFirmChasedTwice } from "../invoice/chase-log";
import { assertFirmClerkBudget } from "./budget";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { getClerkGateway } from "./provider";

// Weekly firm digest (Clerk power D). Every fact in a digest — counts of
// unsubmitted, due-soon, overdue and failed invoices, aged receivables — is
// computed by SQL over the firm's own data. The model's ONLY job is phrasing;
// when it can't (kill switch, budget, invalid output) the deterministic
// template text is stored instead, so a digest never fails for AI reasons and
// never contains a number the platform didn't compute.
//
// Generation runs on the shared sweep loop behind the OPT-IN clerk_digest
// flag (it can spend firm tokens); the unique (firm_id, week_start) key makes
// the sweep idempotent across instances and passes.

const DIGEST_FLAG_KEY = "clerk_digest";
const DIGEST_LOCK_ID = 731_843;
// Firms per sweep pass; the loop naturally resumes where it left off because
// generated firms drop out of the missing-digest query.
const DIGEST_BATCH = 20;
// Undelivered digests offered per delivery pass; claimed rows drop out of
// the scan, so a backlog drains across passes instead of pinning one.
const DELIVERY_BATCH = 50;

// v2 (round 14): the user facts gained the unmatched-credit and 2+-reminder
// lines, so the model path can never lag the template path (review M1).
const DIGEST_PROMPT_VERSION = "digest.v2";
const DIGEST_SYSTEM = [
  "You write a short weekly compliance digest for a Nigerian accounting firm, from facts computed by the platform.",
  "Use ONLY the facts provided. Never add, change or estimate a number, date, deadline or rule that is not in them.",
  "Every bullet must correspond to at least one provided fact. Skip facts with a zero count rather than mentioning them.",
  "Tone: professional, plain, encouraging. One headline sentence, then up to 5 short bullets.",
  'Return JSON: {"headline": string, "bullets": string[]}.',
].join("\n");

const digestOutput = z.object({
  headline: z.string().min(1).max(300),
  bullets: z.array(z.string().min(1).max(400)).max(5),
});

const digestJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "bullets"],
  properties: {
    headline: { type: "string" },
    bullets: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
};

export interface DigestFacts {
  unsubmittedCount: number;
  dueSoonCount: number;
  overdueCount: number;
  failedCount: number;
  receivablesOver60Count: number;
  // Expected-but-unraised recurring invoices across the firm's clients
  // (unbilled-income.ts — same miner as the recurring/unbilled cards).
  unbilledCount: number;
  unbilledClients: number;
  // Money facts (round-11 idea #3), from the same firm summary the Ask Clerk
  // money intents use (cashflow.ts firmMoneySummary): payments expected in
  // the coming week per each buyer's own rhythm, and invoices past BOTH
  // their due date and that rhythm — the chase-worthy set.
  expectedWeekCount: number;
  expectedWeekTotalNgn: string;
  chaseWorthyCount: number;
  // Round-14 money facts: bank credits with no invoice behind them (the
  // unmatched-credit detector's firm-wide count — potential off-platform
  // sales), and outstanding invoices that already took 2+ logged reminders
  // (the chase ladder's "polite nudging is not moving this" set).
  unmatchedCreditCount: number;
  unmatchedCreditClients: number;
  chasedTwiceCount: number;
}

// Monday 00:00 UTC of the week containing `now` — the digest's identity key.
export function digestWeekStart(now: Date = new Date()): Date {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dow = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return d;
}

// The digest's facts, straight from SQL over the firm's invoices. Statuses
// and reference dates mirror compliance-window.ts / receivables.ts so the
// digest can never disagree with the dashboards — including the Lagos-calendar
// "today" (lib/lagos-time.ts): current_date would use the UTC day, which lags
// local statutory time by an hour around midnight.
export async function computeDigestFacts(firmId: string): Promise<DigestFacts> {
  const today = lagosTodaySql();
  const rows = (
    await getDb().execute<{
      unsubmitted: number;
      due_soon: number;
      overdue: number;
      failed: number;
      recv_over_60: number;
    }>(sql`
      SELECT
        COUNT(*) FILTER (
          WHERE i.status IN ('draft', 'validated')
        )::int AS unsubmitted,
        COUNT(*) FILTER (
          WHERE i.status IN ('draft', 'validated')
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int > ${today}
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${today} + 7
        )::int AS due_soon,
        -- The deadline is Lagos midnight STARTING day issue+window, so an
        -- invoice is overdue ON that day (<=) — same boundary as the
        -- dashboards, reminders and the Ask Clerk data intents.
        COUNT(*) FILTER (
          WHERE i.status IN ('draft', 'validated')
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= ${today}
        )::int AS overdue,
        COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
        COUNT(*) FILTER (
          WHERE i.status IN ('submitted', 'stamped', 'confirmed')
            AND COALESCE(i.due_date, i.issue_date) < ${today} - 60
        )::int AS recv_over_60
      FROM invoices i
      WHERE i.kind = 'invoice' AND i.firm_id = ${firmId}
    `)
  ).rows;
  const r = rows[0];
  const unbilled = await countFirmUnbilled(firmId);
  const money = await firmMoneySummary(firmId);
  const unmatched = await countFirmUnmatchedCredits(firmId);
  const chasedTwice = await countFirmChasedTwice(firmId);
  return {
    unsubmittedCount: Number(r?.unsubmitted ?? 0),
    dueSoonCount: Number(r?.due_soon ?? 0),
    overdueCount: Number(r?.overdue ?? 0),
    failedCount: Number(r?.failed ?? 0),
    receivablesOver60Count: Number(r?.recv_over_60 ?? 0),
    unbilledCount: unbilled.alerts,
    unbilledClients: unbilled.clients,
    expectedWeekCount: money.expectedWeekCount,
    expectedWeekTotalNgn: money.expectedWeekTotalNgn,
    chaseWorthyCount: money.chaseCount,
    unmatchedCreditCount: unmatched.credits,
    unmatchedCreditClients: unmatched.clients,
    chasedTwiceCount: chasedTwice,
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function isAre(n: number): string {
  return n === 1 ? "is" : "are";
}

// The deterministic fallback narrative — also the grounding shown to the
// model. Pure so it is unit-testable.
export function buildTemplateDigest(facts: DigestFacts): {
  headline: string;
  bullets: string[];
} {
  const bullets: string[] = [];
  if (facts.overdueCount > 0) {
    bullets.push(
      `${plural(facts.overdueCount, "invoice")} ${isAre(facts.overdueCount)} past the ${SUBMISSION_WINDOW_DAYS}-day submission window — submit these first to limit penalty exposure.`,
    );
  }
  if (facts.dueSoonCount > 0) {
    bullets.push(
      `${plural(facts.dueSoonCount, "invoice")} due for submission within the next 7 days.`,
    );
  }
  if (facts.failedCount > 0) {
    bullets.push(
      `${plural(facts.failedCount, "invoice")} failed submission — open the invoice for the specific fix.`,
    );
  }
  if (facts.unsubmittedCount > 0) {
    bullets.push(
      `${plural(facts.unsubmittedCount, "invoice")} in total ${isAre(facts.unsubmittedCount)} still unsubmitted (draft or validated).`,
    );
  }
  if (facts.receivablesOver60Count > 0) {
    bullets.push(
      `${plural(facts.receivablesOver60Count, "receivable")} ${isAre(facts.receivablesOver60Count)} more than 60 days old — consider chasing payment.`,
    );
  }
  if (facts.unbilledCount > 0) {
    bullets.push(
      `${plural(facts.unbilledCount, "regular invoice")} ${facts.unbilledCount === 1 ? "looks" : "look"} unraised across ${plural(facts.unbilledClients, "client")} — ${facts.unbilledCount === 1 ? "a monthly billing habit" : "monthly billing habits"} with nothing issued this cycle.`,
    );
  }
  if (facts.expectedWeekCount > 0) {
    bullets.push(
      `${plural(facts.expectedWeekCount, "invoice")} (NGN ${facts.expectedWeekTotalNgn}) ${isAre(facts.expectedWeekCount)} expected to be paid in the coming week, based on each customer's own payment rhythm.`,
    );
  }
  if (facts.chaseWorthyCount > 0) {
    bullets.push(
      `${plural(facts.chaseWorthyCount, "receivable")} ${facts.chaseWorthyCount === 1 ? "looks" : "look"} worth chasing — past both the due date and the customer's usual payment rhythm.`,
    );
  }
  if (facts.unmatchedCreditCount > 0) {
    bullets.push(
      `${plural(facts.unmatchedCreditCount, "bank credit")} across ${plural(facts.unmatchedCreditClients, "client")} match${facts.unmatchedCreditCount === 1 ? "es" : ""} no invoice on the platform — if any is a sale, an e-invoice should exist for it.`,
    );
  }
  if (facts.chasedTwiceCount > 0) {
    bullets.push(
      `${plural(facts.chasedTwiceCount, "invoice")} ${facts.chasedTwiceCount === 1 ? "has" : "have"} taken 2 or more payment reminders and ${isAre(facts.chasedTwiceCount)} still unpaid.`,
    );
  }
  const urgent = facts.overdueCount + facts.failedCount;
  const headline =
    urgent > 0
      ? `${plural(urgent, "invoice")} ${urgent === 1 ? "needs" : "need"} attention this week.`
      : facts.dueSoonCount > 0
        ? `You're nearly clear — ${plural(facts.dueSoonCount, "deadline")} coming up this week.`
        : "You're on track: nothing is overdue or failing this week.";
  if (bullets.length === 0) {
    bullets.push(
      "No unsubmitted invoices, no failures and no aged receivables. Nothing needs your attention.",
    );
  }
  return { headline, bullets };
}

// Generate (or return the existing) digest for one firm and week. Charged to
// the firm's Clerk budget when the model phrases it; NEVER blocked by budget
// or kill switch — the template path always succeeds.
export async function generateFirmDigest(
  firmId: string,
  gateway: ClerkGateway | null,
  now: Date = new Date(),
): Promise<ClerkDigestRow> {
  const weekStart = digestWeekStart(now);
  const [existing] = await getDb()
    .select()
    .from(clerkDigestsTable)
    .where(
      and(
        eq(clerkDigestsTable.firmId, firmId),
        eq(clerkDigestsTable.weekStart, weekStart),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const facts = await computeDigestFacts(firmId);
  const template = buildTemplateDigest(facts);
  let headline = template.headline;
  let bullets = template.bullets;
  let source: "clerk" | "template" = "template";

  let clerkAvailable = gateway !== null && (await isFeatureEnabled(CLERK_FLAG_KEY));
  if (clerkAvailable) {
    try {
      await assertFirmClerkBudget(firmId);
    } catch {
      clerkAvailable = false;
    }
  }
  if (clerkAvailable && gateway) {
    const user = [
      "Weekly compliance facts for the firm:",
      `- Invoices past the submission window (overdue): ${facts.overdueCount}`,
      `- Invoices whose submission deadline falls in the next 7 days: ${facts.dueSoonCount}`,
      `- Invoices that failed submission: ${facts.failedCount}`,
      `- Unsubmitted invoices in total (draft or validated): ${facts.unsubmittedCount}`,
      `- Receivables older than 60 days: ${facts.receivablesOver60Count}`,
      `- Regular monthly invoices that look unraised this cycle: ${facts.unbilledCount} (across ${facts.unbilledClients} client(s))`,
      `- Payments expected in the coming week (customers' own rhythms): ${facts.expectedWeekCount} invoice(s), NGN ${facts.expectedWeekTotalNgn}`,
      `- Receivables worth chasing (past due date AND the customer's usual rhythm): ${facts.chaseWorthyCount}`,
      `- Bank credits matching no invoice on the platform: ${facts.unmatchedCreditCount} (across ${facts.unmatchedCreditClients} client(s))`,
      `- Invoices with 2+ payment reminders sent and still unpaid: ${facts.chasedTwiceCount}`,
      `- The statutory submission window is ${SUBMISSION_WINDOW_DAYS} days from the issue date.`,
    ].join("\n");
    const result = await gateway.infer<z.infer<typeof digestOutput>>({
      purpose: "digest",
      firmId,
      promptVersion: DIGEST_PROMPT_VERSION,
      system: DIGEST_SYSTEM,
      user,
      schemaName: "weekly_digest",
      jsonSchema: digestJsonSchema,
      validator: digestOutput,
      inputForHash: `${firmId}:${weekStart.toISOString()}:${JSON.stringify(facts)}`,
    });
    if (result.ok) {
      headline = result.data.headline;
      bullets = result.data.bullets.length ? result.data.bullets : bullets;
      source = "clerk";
    }
  }

  // Two instances racing resolve on the (firm_id, week_start) unique key: the
  // loser reads the winner's row.
  const [inserted] = await getDb()
    .insert(clerkDigestsTable)
    .values({ firmId, weekStart, headline, bullets, source })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [winner] = await getDb()
    .select()
    .from(clerkDigestsTable)
    .where(
      and(
        eq(clerkDigestsTable.firmId, firmId),
        eq(clerkDigestsTable.weekStart, weekStart),
      ),
    )
    .limit(1);
  return winner;
}

// Offer generated digests to the firm's OPTED-IN staff, mirroring
// deliverClientStatements: oldest-first delivered_at IS NULL scan, claim-
// first compare-and-set as the atomic once-only gate, dark
// messaging_notifications flag claims silently (PL-02 — turning the flag on
// later must not blast a backlog of old digests). Two deliberate differences
// from the statement fan-out:
//  - recipients come from staff_notification_preferences (digestEnabled plus
//    at least one channel on) joined against a LIVE firm membership
//    (firm_admin/firm_staff in that firm — an offboarded member's stale
//    preference row must not keep receiving the firm's digests); NO
//    recipients claims silently, because opt-in means quiet is the correct
//    outcome, not a failure;
//  - there is NO party consent gate: the recipient is a firm member who
//    opted in to their own firm's digest themselves — this is not the
//    CORE-03 client-alert model, and no client party's consent governs it.
// Payloads stay pointer-only (SEC-12): the user pointer as recipientRef and
// a dig-<letters> digest pointer as entityId — never the member's email
// address (the address lives only on the preference row; the simulated
// messaging provider addresses nothing today, matching every existing send).
// Returns the number of rows CLAIMED this pass; zero means the backlog is
// drained, so callers can loop until then.
//
// Sweep-only: must run OUTSIDE any request context. The candidate/recipient
// reads and the sends run on the ambient-free raw pool (autocommit — each
// message/push insert is individually durable); only the per-row claim opens
// a transaction, and it COMMITS before any send leaves. Holding one bypass
// transaction across the whole pass — claims, recipient reads AND the live
// Expo push HTTP — meant a mid-pass failure rolled back every claim and
// message row while pushes had already left the building, and sibling
// instances blocked on the row locks for the duration.
export async function deliverFirmDigests(limit = DELIVERY_BATCH): Promise<number> {
  // Plain short read (raw pool): candidate rows, oldest first, so a backlog
  // wider than one pass drains in generation order.
  const pending = await getDb()
    .select()
    .from(clerkDigestsTable)
    .where(isNull(clerkDigestsTable.deliveredAt))
    .orderBy(clerkDigestsTable.createdAt)
    .limit(limit);
  if (pending.length === 0) return 0;

  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const row of pending) {
    // Claim first, in its OWN short committed transaction: the compare-and-
    // set on delivered_at is the atomic once-only gate, and committing it
    // before sending is the at-most-once trade — a claimed row whose sends
    // then fail is NOT re-offered (better a missed nudge than a double
    // alert; the console shows the digest either way).
    const claim = await runInBypassContext(() =>
      getDb()
        .update(clerkDigestsTable)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            eq(clerkDigestsTable.id, row.id),
            isNull(clerkDigestsTable.deliveredAt),
          ),
        )
        .returning({ id: clerkDigestsTable.id }),
    );
    if (claim.length === 0) continue; // another instance won this row
    claimed++;

    // The claim is written even while messaging is dark (PL-02).
    if (!messagingOn) continue;

    // Opted-in staff with at least one live channel AND a current staff
    // membership in this firm (offboarding revokes the membership, not the
    // self-service preference row — the join is what stops a departed
    // member's digests). Nobody left → the claim above already retired the
    // row; send nothing. selectDistinct: a user holding both staff roles in
    // the firm must still be addressed once. The EMAIL channel additionally
    // requires the saved address to be VERIFIED (emailVerifiedAt — see
    // routes/staff.ts): an unverified address must never influence where a
    // digest notification lands. Push is unaffected — it targets the
    // member's own registered devices, not a typed-in address.
    const recipients = (
      await getDb()
        .selectDistinct({
          userId: staffNotificationPreferencesTable.userId,
          emailEnabled: staffNotificationPreferencesTable.emailEnabled,
          pushEnabled: staffNotificationPreferencesTable.pushEnabled,
          email: staffNotificationPreferencesTable.email,
          emailVerifiedAt: staffNotificationPreferencesTable.emailVerifiedAt,
        })
        .from(staffNotificationPreferencesTable)
        .innerJoin(
          membershipsTable,
          and(
            eq(membershipsTable.userId, staffNotificationPreferencesTable.userId),
            eq(membershipsTable.firmId, staffNotificationPreferencesTable.firmId),
            inArray(membershipsTable.role, ["firm_admin", "firm_staff"]),
          ),
        )
        .where(
          and(
            eq(staffNotificationPreferencesTable.firmId, row.firmId),
            eq(staffNotificationPreferencesTable.digestEnabled, true),
          ),
        )
    ).filter(
      (r) =>
        (r.emailEnabled && r.email !== null && r.emailVerifiedAt !== null) ||
        r.pushEnabled,
    );

    // Sends happen AFTER the claim committed, outside any open transaction:
    // each message/push write is an autocommit insert, so a crash here loses
    // at most the remaining channels of one digest — never a committed claim.
    const entityId = pointerEntityRef("dig", row.id);
    for (const recipient of recipients) {
      if (
        recipient.emailEnabled &&
        recipient.email &&
        recipient.emailVerifiedAt
      ) {
        try {
          await sendMessage({
            channel: "email",
            recipientRef: pointerEntityRef("usr", recipient.userId),
            templateKey: "firm_digest_ready",
            entityType: "clerk_digest",
            entityId,
          });
        } catch {
          // Channel failures are recorded in the messages ledger.
        }
      }
      if (recipient.pushEnabled) {
        try {
          await sendPushToUser({
            userId: recipient.userId,
            templateKey: "firm_digest_ready",
            entityType: "clerk_digest",
            entityId,
          });
        } catch {
          // Push failures are likewise recorded by the push module.
        }
      }
    }
  }
  return claimed;
}

// Latest digest for a firm (the route's read path; RLS-scoped by 0011).
export async function latestDigestForFirm(
  firmId: string,
): Promise<ClerkDigestRow | null> {
  const [row] = await getDb()
    .select()
    .from(clerkDigestsTable)
    .where(eq(clerkDigestsTable.firmId, firmId))
    .orderBy(desc(clerkDigestsTable.weekStart))
    .limit(1);
  return row ?? null;
}

registerSweep(async function sweepClerkDigests(): Promise<void> {
  // Opt-in: generating digests for every firm can spend firm tokens, so the
  // flag must be turned on deliberately (off/missing = no digests at all).
  if (await isFeatureEnabled(DIGEST_FLAG_KEY)) {
    // Candidate selection is a SHORT bypass transaction; generation — which
    // makes one model call per firm — runs OUTSIDE it. Holding one transaction
    // (and the advisory lock, and a pooled connection) across up to 20 provider
    // calls made a slow provider stall the entire shared sweep loop, delaying
    // the minute-sensitive statutory alerts behind it. The lock now only
    // de-duplicates candidate selection within a pass; cross-instance
    // idempotency rests where it always did — the (firm_id, week_start) unique
    // key — so a rare concurrent pass wastes at most one phrasing call per firm
    // and never stores a duplicate.
    const firms = await runInBypassContext(async () => {
      const [{ locked }] = (
        await getDb().execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${DIGEST_LOCK_ID}) AS locked`,
        )
      ).rows;
      if (!locked) return [];

      const weekStart = digestWeekStart();
      return getDb()
        .select({ id: firmsTable.id })
        .from(firmsTable)
        .leftJoin(
          clerkDigestsTable,
          and(
            eq(clerkDigestsTable.firmId, firmsTable.id),
            eq(clerkDigestsTable.weekStart, weekStart),
          ),
        )
        .where(isNull(clerkDigestsTable.id))
        .limit(DIGEST_BATCH);
    });
    if (firms.length > 0) {
      // No provider configured (or kill switch off) still produces digests —
      // just from the template path.
      let gateway: ClerkGateway | null = null;
      try {
        gateway = await getClerkGateway();
      } catch {
        gateway = null;
      }
      let generated = 0;
      for (const firm of firms) {
        await generateFirmDigest(firm.id, gateway);
        generated += 1;
      }
      logger.info({ generated }, "clerk digest sweep: weekly digests generated");
    }
  }

  // Delivery runs every pass — even while the generation flag is dark — so
  // digests generated before delivery existed (and stragglers from a bounded
  // pass) are still offered to opted-in staff. The delivered_at
  // compare-and-set keeps this idempotent across instances without the
  // generation lock.
  const delivered = await deliverFirmDigests();
  if (delivered > 0) {
    logger.info(
      { delivered },
      "clerk digest sweep: digests offered to staff notification channels",
    );
  }
});
