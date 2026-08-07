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
import { computeAutomationShadowPending } from "./automation-evidence";
import { ensureGrounded } from "./grounding";
import { pendingApprovals } from "../invoice/approvals";
import { countFirmUnmatchedCollections } from "../collections/unmatched";
import { bandExposure } from "../invoice/penalty-exposure";
import { countFirmMissingBills } from "../invoice/missing-bills";
import { sendMessage } from "../messaging/messaging";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { sendPushToUser } from "../push/push";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import {
  lagosDateString,
  lagosMidnightFor,
  lagosParts,
  lagosTodaySql,
} from "../../lib/lagos-time";
import {
  SUBMISSION_WINDOW_DAYS,
  UNSUBMITTED_STATE,
  pastSubmissionDeadline,
  withinDueSoonWindow,
} from "../invoice/compliance-window";
import { RECEIVABLE_ORIENTATION } from "../invoice/receivables";
import { RECEIVABLE_AGE_DAYS } from "./data-intents/shared";
import { countFirmPayablesDue } from "../invoice/payables";
import { countFirmUnbilled } from "../invoice/unbilled-income";
import { firmMoneySummary } from "../invoice/cashflow";
import {
  OBLIGATION_DUE_SOON_DAYS,
  countOpenObligations,
} from "../obligations/obligations";
import {
  FILING_DUE_SOON_DAYS,
  countOpenFilings,
} from "../filings/filings";
import { statutoryDueDay } from "../filings/statutory-calendar";
import { countWhtChase } from "../wht/credits";
import { countFirmUnmatchedCredits } from "../invoice/unmatched-credits";
import { countFirmChasedTwice } from "../invoice/chase-log";
import { assertFirmClerkBudget } from "./budget";
import { CLERK_FLAG_KEY, inferPhrasing, type ClerkGateway } from "./gateway";
import { gatewayOrNull } from "./provider";
import { isAre, ordinal, plural } from "./text";

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
// v3 (payables round): + the supplier-bills-due line, same reasoning.
// v4 (VAT-position round): + the monthly VAT-return countdown line, same
// reasoning.
// v6: the money-risk facts (s.104 penalty-exposure floor, missing recurring
// vendor bills) joined the fact list — the version bump keeps the model
// path in lockstep with the template path.
// v7 (Notice Desk): + the authority-obligation deadline lines (due-soon /
// overdue notice responses, countOpenObligations), same reasoning.
// v8 (Prove with Clerk Phase 3): + the automation shadow line — what the
// firm's DARK automation switches would act on today
// (computeAutomationShadowPending), same reasoning.
// v9 (Filing Desk Phase 2): + the statutory-returns deadline lines (due-soon
// / overdue unfiled returns, countOpenFilings), same reasoning.
// v10 (WHT Desk): + the outstanding withholding-credit-note chase line
// (countWhtChase), same reasoning.
// v11 (Onboard with Clerk): + the active-onboarding-runs line, same
// reasoning.
const DIGEST_PROMPT_VERSION = "digest.v11";
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
  // Payables round: unpaid supplier bills due within the next 7 days or
  // already overdue (payables.ts countFirmPayablesDue).
  payablesDueCount: number;
  // VAT-position round: days from Lagos-today until the monthly VAT return
  // deadline — the statutory due day of the current Lagos month, or of the
  // next month once it has passed. Null when more than 7 days away (the
  // digest is weekly; a farther deadline is noise). Pure calendar
  // arithmetic, no SQL.
  vatReturnInDays: number | null;
  // Round-17 governance facts: pre-submission invoices blocked on a
  // colleague's approval under the maker-checker policy (BOTH null when the
  // policy is off — "0 waiting" and "no policy" must never read the same),
  // and inbound collection-account payments of the past 7 days the platform
  // could not bind to any invoice.
  approvalsPendingCount: number | null;
  approvalsPendingOldestDays: number | null;
  unmatchedCollectionsCount: number;
  // Round-18 money-risk facts: the s.104 penalty-exposure FLOOR over the
  // firm's overdue paper (small turnover band — null when nothing is
  // overdue), and vendors with a monthly capture habit whose bill has not
  // been captured this cycle (the payables mirror of unbilledCount).
  penaltyExposureFloorNgn: string | null;
  missingBillsCount: number;
  missingBillsClients: number;
  // Notice Desk: open authority obligations whose response date falls within
  // OBLIGATION_DUE_SOON_DAYS / has passed (countOpenObligations — the single
  // obligations fact function, so the digest can never disagree with the
  // Notice Desk). OPTIONAL (builders default an absent value to 0): sibling
  // test files construct full DigestFacts literals that predate these fields,
  // and stored fact snapshots (clerk_digests.facts) from earlier weeks lack
  // them; computeDigestFacts always populates both.
  obligationsDueSoon?: number;
  obligationsOverdue?: number;
  // Prove with Clerk Phase 3: what the firm's DARK automation kinds would
  // act on today (computeAutomationShadowPending). NULL means every switch
  // is lit — there is no shadow to report and the line must stay silent.
  // OPTIONAL for the same snapshot/legacy-literal reasons as the obligation
  // facts; builders treat an absent value as null.
  automationShadowPending?: number | null;
  // Filing Desk: unfiled statutory returns whose filing date falls within
  // FILING_DUE_SOON_DAYS / has passed (countOpenFilings — the single filings
  // fact function, so the digest can never disagree with the register).
  // OPTIONAL for the same snapshot/legacy-literal reasons as the obligation
  // facts; builders default an absent value to 0.
  filingsDueSoon?: number;
  filingsOverdue?: number;
  // WHT Desk: recorded withholding deductions whose buyer credit note is
  // still outstanding (countWhtChase — the single WHT chase fact function,
  // so the digest can never disagree with the ledger). OPTIONAL for the
  // same snapshot/legacy-literal reasons; builders default an absent value
  // to 0.
  whtAwaitingNotes?: number;
  // Onboard with Clerk (round 44): client onboarding runs still in
  // progress. Optional for the same snapshot/legacy reasons.
  onboardingActiveRuns?: number;
}

// The monthly VAT-return countdown, PURE and Lagos-anchored (lagosParts /
// lagosMidnightFor — WAT is a fixed +01:00, so this is plain offset
// arithmetic, never local Date math): days from the Lagos calendar today to
// the NEXT statutory due day (the Filing Desk one-home owns the number;
// round 41 folded this surface onto it) — this month's while today is on or
// before it, otherwise next month's (month overflow carries into the year
// like Date.UTC). Returns null when the deadline is more than 7 days out, so
// the weekly digest only speaks up when the clock is actually close.
export function vatReturnInDays(now: Date = new Date()): number | null {
  const { year, monthIndex } = lagosParts(now);
  const day = Number(lagosDateString(now).slice(8, 10));
  const today = lagosMidnightFor(year, monthIndex, day);
  const dueDay = statutoryDueDay("vat");
  const due =
    day <= dueDay
      ? lagosMidnightFor(year, monthIndex, dueDay)
      : lagosMidnightFor(year, monthIndex + 1, dueDay);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  return days > 7 ? null : days;
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
        -- Orientation on the unsubmitted-state counters (payables round):
        -- captured supplier BILLS are draft forever, so without the
        -- receivable-orientation predicate every bill would pollute the
        -- unsubmitted/due-soon/overdue numbers with deadlines that do not
        -- exist for them.
        COUNT(*) FILTER (
          WHERE ${UNSUBMITTED_STATE}
            AND ${RECEIVABLE_ORIENTATION}
        )::int AS unsubmitted,
        COUNT(*) FILTER (
          WHERE ${UNSUBMITTED_STATE}
            AND ${RECEIVABLE_ORIENTATION}
            AND ${withinDueSoonWindow(today)}
        )::int AS due_soon,
        -- The deadline boundary (overdue ON day issue+window, <=) lives in
        -- compliance-window.ts — the same fragment as the dashboards,
        -- reminders, penalty card and the Ask Clerk data intents.
        COUNT(*) FILTER (
          WHERE ${UNSUBMITTED_STATE}
            AND ${RECEIVABLE_ORIENTATION}
            AND ${pastSubmissionDeadline(today)}
        )::int AS overdue,
        COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
        -- The age cutoff is RECEIVABLE_AGE_DAYS (data-intents/shared.ts) —
        -- the same constant the data.aged_receivables Ask intent
        -- interpolates, so the two spellings cannot drift apart.
        COUNT(*) FILTER (
          WHERE i.status IN ('submitted', 'stamped', 'confirmed')
            AND COALESCE(i.due_date, i.issue_date) < ${today} - ${RECEIVABLE_AGE_DAYS}::int
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
  const payablesDue = await countFirmPayablesDue(firmId);
  const approvals = await pendingApprovals(firmId);
  const unmatchedCollections = await countFirmUnmatchedCollections(firmId, 7);
  const missingBills = await countFirmMissingBills(firmId);
  const obligations = await countOpenObligations(firmId);
  const automationShadowPending = await computeAutomationShadowPending(firmId);
  const filings = await countOpenFilings(firmId);
  const whtChase = await countWhtChase(firmId);
  // Onboard with Clerk (round 44): active onboarding runs — one indexed
  // count; the checklist's own facts stay with the run, the digest only
  // says how many books are still landing.
  const onboarding = (
    await getDb().execute<{ active: number }>(sql`
      SELECT COUNT(*)::int AS active
      FROM client_onboarding_runs
      WHERE firm_id = ${firmId} AND status = 'active'
    `)
  ).rows;
  // The penalty floor is DERIVED from the overdue count this query already
  // computed — a second COUNT under the same predicate could straddle a
  // Lagos midnight and let one digest say "0 overdue" next to a non-zero
  // exposure. One count, one spelling, no second query.
  const overdueCount = Number(r?.overdue ?? 0);
  return {
    unsubmittedCount: Number(r?.unsubmitted ?? 0),
    dueSoonCount: Number(r?.due_soon ?? 0),
    overdueCount,
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
    payablesDueCount: payablesDue,
    vatReturnInDays: vatReturnInDays(),
    approvalsPendingCount: approvals?.count ?? null,
    approvalsPendingOldestDays: approvals?.oldestDays ?? null,
    unmatchedCollectionsCount: unmatchedCollections,
    penaltyExposureFloorNgn:
      overdueCount > 0 ? bandExposure(overdueCount).small : null,
    missingBillsCount: missingBills.alerts,
    missingBillsClients: missingBills.clients,
    obligationsDueSoon: obligations.dueSoon,
    obligationsOverdue: obligations.overdue,
    automationShadowPending,
    filingsDueSoon: filings.dueSoon,
    filingsOverdue: filings.overdue,
    whtAwaitingNotes: whtChase.awaiting,
    onboardingActiveRuns: Number(onboarding[0]?.active ?? 0),
  };
}

// The ordered fact-line registry: ONE entry per digest fact, rendering BOTH
// the model path (its line in the buildDigestUser prompt, always emitted) and
// the template path (its conditional buildTemplateDigest bullet, null when
// the fact is zero/off). The v2–v7 history above records five rounds of
// re-synchronizing those two paths by hand; the registry makes the lockstep
// structural — a new fact is one entry here and necessarily reaches both
// renderers. The prompt lines are BYTE-SENSITIVE (DIGEST_PROMPT_VERSION pins
// them; the phrasing eval replays production's exact assembly), so editing a
// promptLine is a prompt change and carries the usual version-bump
// discipline. The headline, the empty-bullets fallback and the statutory-
// window footer stay bespoke in their builders below.
interface DigestFactLine {
  promptLine: (facts: DigestFacts) => string;
  bullet: (facts: DigestFacts) => string | null;
}

const DIGEST_FACT_LINES: readonly DigestFactLine[] = [
  {
    promptLine: (facts) =>
      `- Invoices past the submission window (overdue): ${facts.overdueCount}`,
    bullet: (facts) =>
      facts.overdueCount > 0
        ? `${plural(facts.overdueCount, "invoice")} ${isAre(facts.overdueCount)} past the ${SUBMISSION_WINDOW_DAYS}-day submission window — submit these first to limit penalty exposure.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Invoices whose submission deadline falls in the next 7 days: ${facts.dueSoonCount}`,
    bullet: (facts) =>
      facts.dueSoonCount > 0
        ? `${plural(facts.dueSoonCount, "invoice")} due for submission within the next 7 days.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Invoices that failed submission: ${facts.failedCount}`,
    bullet: (facts) =>
      facts.failedCount > 0
        ? `${plural(facts.failedCount, "invoice")} failed submission — open the invoice for the specific fix.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Unsubmitted invoices in total (draft or validated): ${facts.unsubmittedCount}`,
    bullet: (facts) =>
      facts.unsubmittedCount > 0
        ? `${plural(facts.unsubmittedCount, "invoice")} in total ${isAre(facts.unsubmittedCount)} still unsubmitted (draft or validated).`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Receivables older than ${RECEIVABLE_AGE_DAYS} days: ${facts.receivablesOver60Count}`,
    bullet: (facts) =>
      facts.receivablesOver60Count > 0
        ? `${plural(facts.receivablesOver60Count, "receivable")} ${isAre(facts.receivablesOver60Count)} more than ${RECEIVABLE_AGE_DAYS} days old — consider chasing payment.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Regular monthly invoices that look unraised this cycle: ${facts.unbilledCount} (across ${facts.unbilledClients} client(s))`,
    bullet: (facts) =>
      facts.unbilledCount > 0
        ? `${plural(facts.unbilledCount, "regular invoice")} ${facts.unbilledCount === 1 ? "looks" : "look"} unraised across ${plural(facts.unbilledClients, "client")} — ${facts.unbilledCount === 1 ? "a monthly billing habit" : "monthly billing habits"} with nothing issued this cycle.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Payments expected in the coming week (customers' own rhythms): ${facts.expectedWeekCount} invoice(s), NGN ${facts.expectedWeekTotalNgn}`,
    bullet: (facts) =>
      facts.expectedWeekCount > 0
        ? `${plural(facts.expectedWeekCount, "invoice")} (NGN ${facts.expectedWeekTotalNgn}) ${isAre(facts.expectedWeekCount)} expected to be paid in the coming week, based on each customer's own payment rhythm.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Receivables worth chasing (past due date AND the customer's usual rhythm): ${facts.chaseWorthyCount}`,
    bullet: (facts) =>
      facts.chaseWorthyCount > 0
        ? `${plural(facts.chaseWorthyCount, "receivable")} ${facts.chaseWorthyCount === 1 ? "looks" : "look"} worth chasing — past both the due date and the customer's usual payment rhythm.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Bank credits matching no invoice on the platform: ${facts.unmatchedCreditCount} (across ${facts.unmatchedCreditClients} client(s))`,
    bullet: (facts) =>
      facts.unmatchedCreditCount > 0
        ? `${plural(facts.unmatchedCreditCount, "bank credit")} across ${plural(facts.unmatchedCreditClients, "client")} match${facts.unmatchedCreditCount === 1 ? "es" : ""} no invoice on the platform — if any is a sale, an e-invoice should exist for it.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Invoices with 2+ payment reminders sent and still unpaid: ${facts.chasedTwiceCount}`,
    bullet: (facts) =>
      facts.chasedTwiceCount > 0
        ? `${plural(facts.chasedTwiceCount, "invoice")} ${facts.chasedTwiceCount === 1 ? "has" : "have"} taken 2 or more payment reminders and ${isAre(facts.chasedTwiceCount)} still unpaid.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Unpaid supplier bills due within the next 7 days or overdue: ${facts.payablesDueCount}`,
    bullet: (facts) =>
      facts.payablesDueCount > 0
        ? `${plural(facts.payablesDueCount, "supplier bill")} ${isAre(facts.payablesDueCount)} due within the next 7 days or already overdue — worth scheduling the payments.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Days until the monthly VAT return deadline (the ${ordinal(statutoryDueDay("vat"))}): ${facts.vatReturnInDays ?? "more than 7 — do not mention"}`,
    bullet: (facts) =>
      facts.vatReturnInDays !== null
        ? `Monthly VAT return due ${facts.vatReturnInDays === 0 ? "today" : `in ${plural(facts.vatReturnInDays, "day")}`} — VAT returns fall due on the ${ordinal(statutoryDueDay("vat"))}.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Invoices waiting for a colleague's approval before submission: ${facts.approvalsPendingCount ?? "approval policy off — do not mention"}${
        facts.approvalsPendingCount !== null && facts.approvalsPendingOldestDays !== null
          ? ` (oldest waiting ${facts.approvalsPendingOldestDays} day(s))`
          : ""
      }`,
    bullet: (facts) =>
      facts.approvalsPendingCount !== null && facts.approvalsPendingCount > 0
        ? `${plural(facts.approvalsPendingCount, "invoice")} ${isAre(facts.approvalsPendingCount)} waiting for a colleague's approval before submission${
            facts.approvalsPendingOldestDays !== null &&
            facts.approvalsPendingOldestDays > 0
              ? ` — the oldest has waited ${plural(facts.approvalsPendingOldestDays, "day")}`
              : ""
          }.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Collection-account payments this week matching no invoice: ${facts.unmatchedCollectionsCount}`,
    bullet: (facts) =>
      facts.unmatchedCollectionsCount > 0
        ? `${plural(facts.unmatchedCollectionsCount, "payment")} arrived on your collection accounts this week that matched no invoice — reconcile against the provider statement.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Estimated s.104 penalty exposure for the overdue paper (small-band floor): ${facts.penaltyExposureFloorNgn !== null ? `NGN ${facts.penaltyExposureFloorNgn}` : "none — do not mention"}`,
    bullet: (facts) =>
      facts.penaltyExposureFloorNgn !== null
        ? `Overdue submissions carry at least NGN ${facts.penaltyExposureFloorNgn} of s.104 penalty exposure (lowest turnover band) — an estimate, not advice.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Regular vendor bills that look uncaptured this cycle: ${facts.missingBillsCount} (across ${facts.missingBillsClients} client(s))`,
    bullet: (facts) =>
      facts.missingBillsCount > 0
        ? `${plural(facts.missingBillsCount, "regular vendor bill")} ${facts.missingBillsCount === 1 ? "looks" : "look"} uncaptured this cycle across ${plural(facts.missingBillsClients, "client")} — input VAT may be going unclaimed.`
        : null,
  },
  {
    promptLine: (facts) =>
      `- Authority notices needing a response within ${OBLIGATION_DUE_SOON_DAYS} days: ${facts.obligationsDueSoon ?? 0}`,
    bullet: (facts) => {
      const obligationsDueSoon = facts.obligationsDueSoon ?? 0;
      return obligationsDueSoon > 0
        ? `${plural(obligationsDueSoon, "authority notice")} ${obligationsDueSoon === 1 ? "needs" : "need"} a response within ${OBLIGATION_DUE_SOON_DAYS} days.`
        : null;
    },
  },
  {
    promptLine: (facts) =>
      `- Authority notice responses already overdue: ${facts.obligationsOverdue ?? 0}`,
    bullet: (facts) => {
      const obligationsOverdue = facts.obligationsOverdue ?? 0;
      return obligationsOverdue > 0
        ? `${plural(obligationsOverdue, "authority notice response")} ${isAre(obligationsOverdue)} overdue — these deadlines are the authority's, so respond or escalate first.`
        : null;
    },
  },
  // Prove with Clerk Phase 3: the weekly shadow line. Null (every switch
  // lit) suppresses via the "do not mention" idiom — the lit story belongs
  // to the rollup and effectiveness surfaces, never this counterfactual.
  {
    promptLine: (facts) =>
      `- Items idle automation would act on today (automation is off): ${facts.automationShadowPending ?? "automation on — do not mention"}`,
    bullet: (facts) => {
      const pending = facts.automationShadowPending ?? null;
      return pending !== null && pending > 0
        ? `Clerk automation is off; it would act on ${plural(pending, "item")} today (overdue submissions, failed retries, matched receipts, unbilled patterns) — the portfolio's evidence card shows the backtest.`
        : null;
    },
  },
  // Filing Desk Phase 2: the statutory-returns deadline pair. Vocabulary is
  // deliberately "statutory return" — never the phrase "VAT return", which
  // this digest reserves for the monthly countdown line above (and which the
  // quiet-week phrasing fixture forbids outright).
  {
    promptLine: (facts) =>
      `- Statutory returns due within ${FILING_DUE_SOON_DAYS} days: ${facts.filingsDueSoon ?? 0}`,
    bullet: (facts) => {
      const filingsDueSoon = facts.filingsDueSoon ?? 0;
      return filingsDueSoon > 0
        ? `${plural(filingsDueSoon, "statutory return")} ${isAre(filingsDueSoon)} due to be filed within ${FILING_DUE_SOON_DAYS} days.`
        : null;
    },
  },
  {
    promptLine: (facts) =>
      `- Statutory returns already overdue: ${facts.filingsOverdue ?? 0}`,
    bullet: (facts) => {
      const filingsOverdue = facts.filingsOverdue ?? 0;
      return filingsOverdue > 0
        ? `${plural(filingsOverdue, "statutory return")} ${isAre(filingsOverdue)} already past ${filingsOverdue === 1 ? "its" : "their"} filing date — prepare and file these first.`
        : null;
    },
  },
  // WHT Desk: the credit-note chase line. Vocabulary is deliberately
  // "withholding credit note" — never a bare "credit note" (this digest
  // reserves that phrase family for invoice credit_note documents) and never
  // "VAT" (the quiet-week phrasing fixture forbids the countdown's phrase).
  {
    promptLine: (facts) =>
      `- Withholding credit notes still outstanding: ${facts.whtAwaitingNotes ?? 0}`,
    bullet: (facts) => {
      const whtAwaitingNotes = facts.whtAwaitingNotes ?? 0;
      return whtAwaitingNotes > 0
        ? `${plural(whtAwaitingNotes, "withholding credit note")} from buyers ${isAre(whtAwaitingNotes)} still outstanding — chase these before they go stale.`
        : null;
    },
  },
  // Onboard with Clerk (v11): how many client books are still landing. The
  // checklist's own facts stay with the run — the digest only counts.
  {
    promptLine: (facts) =>
      `- Client onboarding runs still in progress: ${facts.onboardingActiveRuns ?? 0}`,
    bullet: (facts) => {
      const onboardingActiveRuns = facts.onboardingActiveRuns ?? 0;
      return onboardingActiveRuns > 0
        ? `${plural(onboardingActiveRuns, "client onboarding run")} ${isAre(onboardingActiveRuns)} still in progress — the checklist settles itself as history, statements and consent land.`
        : null;
    },
  },
];

// The user prompt the model phrases — extracted so the phrasing eval
// (modules/clerk/phrasing-eval.ts) replays the BYTE-IDENTICAL assembly
// production sends (the buildIntentUser precedent). Pure.
export function buildDigestUser(facts: DigestFacts): string {
  return [
    "Weekly compliance facts for the firm:",
    ...DIGEST_FACT_LINES.map((line) => line.promptLine(facts)),
    `- The statutory submission window is ${SUBMISSION_WINDOW_DAYS} days from the issue date.`,
  ].join("\n");
}

// The digest surface's phrasing seam, one object — the phrasing eval runs
// candidate prompts and fixtures through EXACTLY what production uses.
export const DIGEST_PHRASING = {
  surface: "digest" as const,
  promptVersion: DIGEST_PROMPT_VERSION,
  system: DIGEST_SYSTEM,
  schemaName: "weekly_digest",
  jsonSchema: digestJsonSchema,
  validator: digestOutput,
  buildUser: buildDigestUser,
  joinOutput: (data: z.infer<typeof digestOutput>): string =>
    [data.headline, ...data.bullets].join("\n"),
};

// The deterministic fallback narrative — also the grounding shown to the
// model. Pure so it is unit-testable.
export function buildTemplateDigest(facts: DigestFacts): {
  headline: string;
  bullets: string[];
} {
  // One bullet per non-zero/on fact, in registry order — the SAME order the
  // prompt lines render, by construction.
  const bullets: string[] = DIGEST_FACT_LINES.map((line) =>
    line.bullet(facts),
  ).filter((bullet): bullet is string => bullet !== null);
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
    const user = buildDigestUser(facts);
    // One phrasing call under the digest posture (fix round, after #93): the
    // bare gateway.infer here was a kill-switch TOCTOU — a clerk_ai flip
    // between the clerkAvailable check and the call made the gateway's own
    // assert throw CLERK_DISABLED out of the sweep, failing a generation
    // pass this module documents as NEVER blocked by the kill switch.
    // inferPhrasing re-checks the flag and folds every typed gateway failure
    // to null → template; the outer try keeps the stronger draft-reply.ts
    // guarantee that even a ledger-insert failure after the provider
    // answered, or a grounding-check crash, stores the template row with
    // source tagged honestly.
    try {
      const data = await inferPhrasing<z.infer<typeof digestOutput>>(gateway, {
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
      // Number grounding: a numeral the facts never stated means the template
      // answers instead (grounding.ts) — the phrased digest may only re-say
      // the computed numbers. The grounded text is assembled by the SAME
      // joinOutput the phrasing eval scores, so the eval grades exactly what
      // production grounds.
      if (
        data &&
        (await ensureGrounded(
          "digest",
          firmId,
          DIGEST_PHRASING.joinOutput(data),
          user,
        ))
      ) {
        headline = data.headline;
        bullets = data.bullets.length ? data.bullets : bullets;
        source = "clerk";
      }
    } catch {
      // The template narrative stands; the row below stores it as-is.
    }
  }

  // Two instances racing resolve on the (firm_id, week_start) unique key: the
  // loser reads the winner's row.
  const [inserted] = await getDb()
    .insert(clerkDigestsTable)
    // The fact snapshot is stored WITH the digest (round 20): consecutive
    // weekly snapshots are the impact report's time series. The spread
    // satisfies the column's generic Record type — DigestFacts is an
    // interface, and the schema package cannot import it.
    .values({ firmId, weekStart, headline, bullets, source, facts: { ...facts } })
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
            // The ledger row's REAL recipient identity — the opted-in staff
            // member; the lossy ref stays display/correlation only.
            recipientUserId: recipient.userId,
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
      const gateway = await gatewayOrNull();
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
