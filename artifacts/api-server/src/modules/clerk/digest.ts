import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  getDb,
  runInBypassContext,
  clerkDigestsTable,
  firmsTable,
  type ClerkDigestRow,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { SUBMISSION_WINDOW_DAYS } from "../invoice/compliance-window";
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

const DIGEST_PROMPT_VERSION = "digest.v1";
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
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int > (now() AT TIME ZONE 'Africa/Lagos')::date
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= (now() AT TIME ZONE 'Africa/Lagos')::date + 7
        )::int AS due_soon,
        -- The deadline is Lagos midnight STARTING day issue+window, so an
        -- invoice is overdue ON that day (<=) — same boundary as the
        -- dashboards, reminders and the Ask Clerk data intents.
        COUNT(*) FILTER (
          WHERE i.status IN ('draft', 'validated')
            AND i.issue_date + ${SUBMISSION_WINDOW_DAYS}::int <= (now() AT TIME ZONE 'Africa/Lagos')::date
        )::int AS overdue,
        COUNT(*) FILTER (WHERE i.status = 'failed')::int AS failed,
        COUNT(*) FILTER (
          WHERE i.status IN ('submitted', 'stamped', 'confirmed')
            AND COALESCE(i.due_date, i.issue_date) < (now() AT TIME ZONE 'Africa/Lagos')::date - 60
        )::int AS recv_over_60
      FROM invoices i
      WHERE i.kind = 'invoice' AND i.firm_id = ${firmId}
    `)
  ).rows;
  const r = rows[0];
  return {
    unsubmittedCount: Number(r?.unsubmitted ?? 0),
    dueSoonCount: Number(r?.due_soon ?? 0),
    overdueCount: Number(r?.overdue ?? 0),
    failedCount: Number(r?.failed ?? 0),
    receivablesOver60Count: Number(r?.recv_over_60 ?? 0),
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
  if (!(await isFeatureEnabled(DIGEST_FLAG_KEY))) return;
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
  if (firms.length === 0) return;

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
});
