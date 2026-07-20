import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  getDb,
  runInBypassContext,
  alertPreferencesTable,
  clerkClientStatementsTable,
  engagementsTable,
  type ClerkClientStatementRow,
  type ClientStatementFacts,
} from "@workspace/db";
import { isFeatureEnabled } from "../flags/flags";
import { fanOutAlert } from "../messaging/fan-out";
import { pointerEntityRef } from "../messaging/recipient-ref";
import { registerSweep } from "../pipeline/pipeline";
import { logger } from "../../lib/logger";
import { lagosParts, lagosWindowSql } from "../../lib/lagos-time";
import { assertFirmClerkBudget } from "./budget";
import { CLERK_FLAG_KEY, type ClerkGateway } from "./gateway";
import { getClerkGateway } from "./provider";

// Per-client monthly statement (Clerk idea #5). The weekly digest's posture,
// per client party and per CLOSED Lagos calendar month: "your compliance
// month — 14 invoices stamped, 2 pending, ₦86k VAT". Every fact is SQL over
// the client's own invoices for that month; the model only phrases them, and
// when it can't (kill switch, budget, invalid output) the deterministic
// template text is stored instead — a statement never fails for AI reasons
// and never contains a number the platform didn't compute.
//
// Generation runs on the shared sweep loop behind the OPT-IN
// clerk_client_statements flag (it can spend firm tokens); the unique
// (firm_id, client_party_id, month_start) key makes the sweep idempotent
// across instances and passes. Delivery rides the same sweep through the
// shared consent-gated alert fan-out (claim-first on delivered_at) — the SME
// dashboard reads the statement immediately either way.

const STATEMENT_FLAG_KEY = "clerk_client_statements";
const STATEMENT_LOCK_ID = 731_844;
// (firm, client) pairs per sweep pass; generated pairs drop out of the
// missing-statement candidate query, so the loop resumes where it left off.
const STATEMENT_BATCH = 20;
// Undelivered rows offered per delivery pass; claimed rows drop out of the
// scan, so a backlog drains across passes instead of pinning one.
const DELIVERY_BATCH = 50;

const STATEMENT_PROMPT_VERSION = "client-statement.v1";
const STATEMENT_SYSTEM = [
  "You write a short monthly e-invoicing compliance summary for a Nigerian small business, from facts computed by the platform.",
  "Use ONLY the facts provided. Never add, change or estimate a number, amount, date, deadline or rule that is not in them.",
  "Every bullet must correspond to at least one provided fact. Skip facts with a zero count rather than mentioning them.",
  "Amounts are Nigerian naira; write them as given.",
  "Tone: plain, encouraging, addressed to the business owner. One headline sentence, then up to 5 short bullets.",
  'Return JSON: {"headline": string, "bullets": string[]}.',
].join("\n");

const statementOutput = z.object({
  headline: z.string().min(1).max(300),
  bullets: z.array(z.string().min(1).max(400)).max(5),
});

const statementJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "bullets"],
  properties: {
    headline: { type: "string" },
    bullets: { type: "array", items: { type: "string" }, maxItems: 5 },
  },
};

// The first day (YYYY-MM-01) of the Lagos month `monthsBack` months before
// the one containing `now`. monthsBack=1 is the newest CLOSED month — the
// statement period the sweep generates.
export function lagosMonthStart(monthsBack: number, now: Date = new Date()): string {
  const { year, monthIndex } = lagosParts(now);
  const d = new Date(Date.UTC(year, monthIndex - monthsBack, 1));
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-01`;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-06-01" -> "June 2026" (the statement's display period). */
export function monthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
}

// The month's facts, straight from SQL over ONE client's invoices for ONE
// firm. Predicates mirror the Ask Clerk data intents (Lagos calendar,
// accepted = an accepted submission attempt inside the month) so a statement
// can never disagree with the dashboards or Ask.
export async function computeClientStatementFacts(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
): Promise<ClientStatementFacts> {
  // The in-month attempt window (Lagos calendar) is shared with every other
  // Lagos bucketing predicate via lagosWindowSql.
  const inMonth = lagosWindowSql(sql`sa.created_at`, monthStart);
  const rows = (
    await getDb().execute<{
      issued: number;
      issued_total: string;
      accepted: number;
      accepted_total: string;
      accepted_vat: string;
      failed: number;
      unsubmitted: number;
    }>(sql`
      WITH month_invoices AS (
        SELECT i.*
        FROM invoices i
        WHERE i.kind = 'invoice'
          AND i.firm_id = ${firmId}
          AND i.supplier_party_id = ${clientPartyId}
          AND i.issue_date >= ${monthStart}::date
          AND i.issue_date < ${monthStart}::date + interval '1 month'
      ),
      -- Accepted by the rails DURING the month, whatever month the invoice
      -- was issued in (mirrors data.submitted_this_month). One CTE, one
      -- predicate — the three accepted facts below must agree by construction.
      accepted_invoices AS (
        SELECT i.*
        FROM invoices i
        WHERE i.kind = 'invoice'
          AND i.firm_id = ${firmId}
          AND i.supplier_party_id = ${clientPartyId}
          AND EXISTS (
            SELECT 1 FROM submission_attempts sa
            WHERE sa.invoice_id = i.id AND sa.status = 'accepted'
              AND ${inMonth}
          )
      )
      SELECT
        (SELECT COUNT(*) FROM month_invoices)::int AS issued,
        (SELECT COALESCE(SUM(grand_total), 0) FROM month_invoices)::text AS issued_total,
        (SELECT COUNT(*) FROM accepted_invoices)::int AS accepted,
        (SELECT COALESCE(SUM(grand_total), 0) FROM accepted_invoices)::text AS accepted_total,
        (SELECT COALESCE(SUM(vat_total), 0) FROM accepted_invoices)::text AS accepted_vat,
        -- Distinct invoices whose submission was REJECTED during the month.
        (SELECT COUNT(DISTINCT sa.invoice_id) FROM submission_attempts sa
          JOIN invoices i ON i.id = sa.invoice_id
          WHERE i.kind = 'invoice'
            AND i.firm_id = ${firmId} AND i.supplier_party_id = ${clientPartyId}
            AND sa.status IN ('rejected', 'error')
            AND ${inMonth}
        )::int AS failed,
        -- Issued in the month and STILL unsubmitted today.
        (SELECT COUNT(*) FROM month_invoices
          WHERE status IN ('draft', 'validated'))::int AS unsubmitted
    `)
  ).rows;
  const r = rows[0];
  return {
    issuedCount: Number(r?.issued ?? 0),
    issuedTotal: String(r?.issued_total ?? "0"),
    acceptedCount: Number(r?.accepted ?? 0),
    acceptedTotal: String(r?.accepted_total ?? "0"),
    acceptedVat: String(r?.accepted_vat ?? "0"),
    failedCount: Number(r?.failed ?? 0),
    stillUnsubmittedCount: Number(r?.unsubmitted ?? 0),
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function statementIsQuiet(facts: ClientStatementFacts): boolean {
  return (
    facts.issuedCount === 0 &&
    facts.acceptedCount === 0 &&
    facts.failedCount === 0 &&
    facts.stillUnsubmittedCount === 0
  );
}

// The deterministic fallback narrative — also the grounding shown to the
// model. Pure so it is unit-testable.
export function buildTemplateStatement(
  facts: ClientStatementFacts,
  monthStart: string,
): { headline: string; bullets: string[] } {
  const period = monthLabel(monthStart);
  if (statementIsQuiet(facts)) {
    return {
      headline: `No invoicing activity in ${period}.`,
      bullets: [
        "No invoices were issued and nothing was submitted to the e-invoicing rails.",
      ],
    };
  }
  const bullets: string[] = [];
  if (facts.issuedCount > 0) {
    bullets.push(
      `You issued ${plural(facts.issuedCount, "invoice")} worth NGN ${facts.issuedTotal}.`,
    );
  }
  if (facts.acceptedCount > 0) {
    bullets.push(
      `${plural(facts.acceptedCount, "invoice")} cleared the e-invoicing rails (NGN ${facts.acceptedTotal}, of which NGN ${facts.acceptedVat} VAT).`,
    );
  }
  if (facts.failedCount > 0) {
    bullets.push(
      `${plural(facts.failedCount, "invoice")} had a failed submission during the month — open each invoice for the specific fix.`,
    );
  }
  if (facts.stillUnsubmittedCount > 0) {
    bullets.push(
      `${plural(facts.stillUnsubmittedCount, "invoice")} from ${period} ${facts.stillUnsubmittedCount === 1 ? "is" : "are"} still unsubmitted.`,
    );
  }
  const attention = facts.failedCount + facts.stillUnsubmittedCount;
  const headline =
    attention > 0
      ? `Your ${period} summary: ${plural(facts.acceptedCount, "invoice")} cleared the rails, ${attention} still ${attention === 1 ? "needs" : "need"} attention.`
      : `Your ${period} summary: ${plural(facts.acceptedCount, "invoice")} cleared the rails — all caught up.`;
  return { headline, bullets };
}

// Generate (or return the existing) statement for one (firm, client, month).
// Charged to the firm's Clerk budget when the model phrases it; NEVER blocked
// by budget or kill switch — the template path always succeeds. Quiet months
// store the template row without a model call, so dormant clients cost
// nothing and still converge out of the candidate query.
export async function generateClientStatement(
  firmId: string,
  clientPartyId: string,
  monthStart: string,
  gateway: ClerkGateway | null,
): Promise<ClerkClientStatementRow> {
  const [existing] = await getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(
      and(
        eq(clerkClientStatementsTable.firmId, firmId),
        eq(clerkClientStatementsTable.clientPartyId, clientPartyId),
        eq(clerkClientStatementsTable.monthStart, monthStart),
      ),
    )
    .limit(1);
  if (existing) return existing;

  const facts = await computeClientStatementFacts(
    firmId,
    clientPartyId,
    monthStart,
  );
  const template = buildTemplateStatement(facts, monthStart);
  let headline = template.headline;
  let bullets = template.bullets;
  let source: "clerk" | "template" = "template";

  let clerkAvailable =
    !statementIsQuiet(facts) &&
    gateway !== null &&
    (await isFeatureEnabled(CLERK_FLAG_KEY));
  if (clerkAvailable) {
    try {
      await assertFirmClerkBudget(firmId);
    } catch {
      clerkAvailable = false;
    }
  }
  if (clerkAvailable && gateway) {
    const user = [
      `Monthly compliance facts for one client business, covering ${monthLabel(monthStart)}:`,
      `- Invoices issued in the month: ${facts.issuedCount} (total NGN ${facts.issuedTotal})`,
      `- Invoices accepted by the e-invoicing rails during the month: ${facts.acceptedCount} (total NGN ${facts.acceptedTotal}, VAT NGN ${facts.acceptedVat})`,
      `- Invoices with a failed submission during the month: ${facts.failedCount}`,
      `- Invoices issued in the month and still unsubmitted today: ${facts.stillUnsubmittedCount}`,
    ].join("\n");
    const result = await gateway.infer<z.infer<typeof statementOutput>>({
      purpose: "client_statement",
      firmId,
      promptVersion: STATEMENT_PROMPT_VERSION,
      system: STATEMENT_SYSTEM,
      user,
      schemaName: "client_statement",
      jsonSchema: statementJsonSchema,
      validator: statementOutput,
      inputForHash: `${firmId}:${clientPartyId}:${monthStart}:${JSON.stringify(facts)}`,
    });
    if (result.ok) {
      headline = result.data.headline;
      bullets = result.data.bullets.length ? result.data.bullets : bullets;
      source = "clerk";
    }
  }

  // Two instances racing resolve on the unique key: the loser reads the
  // winner's row.
  const [inserted] = await getDb()
    .insert(clerkClientStatementsTable)
    .values({ firmId, clientPartyId, monthStart, facts, headline, bullets, source })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [winner] = await getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(
      and(
        eq(clerkClientStatementsTable.firmId, firmId),
        eq(clerkClientStatementsTable.clientPartyId, clientPartyId),
        eq(clerkClientStatementsTable.monthStart, monthStart),
      ),
    )
    .limit(1);
  return winner;
}

// The read path (RLS-scoped by 0015; the ROUTE must also narrow client_users
// to their own party — SEC-03, firm-keyed RLS is not a sibling wall).
export async function listClientStatements(
  firmId: string,
  clientPartyId: string,
  limit = 12,
): Promise<ClerkClientStatementRow[]> {
  return getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(
      and(
        eq(clerkClientStatementsTable.firmId, firmId),
        eq(clerkClientStatementsTable.clientPartyId, clientPartyId),
      ),
    )
    .orderBy(desc(clerkClientStatementsTable.monthStart))
    .limit(limit);
}

// Offer generated statements to the client's alert channels through the SAME
// party-scoped fan-out as the deadline reminders: consent-gated (CORE-03 —
// fanOutAlert sends NOTHING without a live layer-1 grant), pointer-only
// payloads (SEC-12 — the message names no month, amounts or counts). Returns
// the number of rows CLAIMED this pass (sends may be fewer: quiet months,
// dark flag and consent refusals claim silently); zero means the backlog is
// drained, so callers can loop until then.
//
// Sweep-only: must run OUTSIDE any request context. The candidate read and
// the sends run on the ambient-free raw pool (autocommit — each message/push
// insert is individually durable); only the per-row claim opens a
// transaction, and it COMMITS before any send leaves. Holding one bypass
// transaction across the whole pass — claims, recipient reads AND the live
// Expo push HTTP — meant a mid-pass failure rolled back every claim and
// message row while pushes had already left the building, and sibling
// instances blocked on the row locks for the duration.
export async function deliverClientStatements(
  limit = DELIVERY_BATCH,
): Promise<number> {
  // Plain short read (raw pool): candidate rows, oldest first, so a backlog
  // wider than one pass drains in generation order.
  const pending = await getDb()
    .select()
    .from(clerkClientStatementsTable)
    .where(isNull(clerkClientStatementsTable.deliveredAt))
    .orderBy(clerkClientStatementsTable.createdAt)
    .limit(limit);
  if (pending.length === 0) return 0;

  const messagingOn = await isFeatureEnabled("messaging_notifications", null);
  let claimed = 0;
  for (const row of pending) {
    // Claim first, in its OWN short committed transaction: the compare-and-
    // set on delivered_at is the atomic once-only gate (mirroring the
    // deadline_reminder_sends ledger), and committing it before sending is
    // the at-most-once trade — a claimed row whose sends then fail is NOT
    // re-offered (better a missed nudge than a double alert; the SME
    // dashboard shows the statement either way).
    const claim = await runInBypassContext(() =>
      getDb()
        .update(clerkClientStatementsTable)
        .set({ deliveredAt: new Date() })
        .where(
          and(
            eq(clerkClientStatementsTable.id, row.id),
            isNull(clerkClientStatementsTable.deliveredAt),
          ),
        )
        .returning({ id: clerkClientStatementsTable.id }),
    );
    if (claim.length === 0) continue; // another instance won this row
    claimed++;

    // A quiet month is not worth a notification: mark it delivered (the
    // claim above) so it stops rescanning forever, but send nothing.
    if (statementIsQuiet(row.facts)) continue;
    // The claim is written even while messaging is dark (PL-02): turning
    // the flag on later must not blast a backlog of old statements.
    if (!messagingOn) continue;

    // Sends happen AFTER the claim committed, outside any open transaction:
    // each fan-out write is an autocommit insert, so a crash here loses at
    // most the remaining channels of one statement — never a committed claim.
    const [prefs] = await getDb()
      .select()
      .from(alertPreferencesTable)
      .where(eq(alertPreferencesTable.clientPartyId, row.clientPartyId))
      .limit(1);
    await fanOutAlert({
      prefs,
      clientPartyId: row.clientPartyId,
      firmId: row.firmId,
      templateKey: "client_statement_ready",
      entityType: "clerk_client_statement",
      entityId: pointerEntityRef("stmt", row.id),
      // Same default as deadline reminders: with no prefs row, SMS is off.
      smsDefaultWhenNoPrefs: false,
    });
  }
  return claimed;
}

export async function sweepClientStatements(): Promise<void> {
  // Opt-in GENERATION only: statements for every engaged client can spend
  // firm tokens, so the flag must be turned on deliberately (off/missing =
  // none generated at all). The flag deliberately does NOT gate delivery
  // below — otherwise turning it off would strand already-generated rows
  // undelivered, and re-enabling would blast the stale backlog at once
  // (the digest sweep's shape, for the same reason).
  if (await isFeatureEnabled(STATEMENT_FLAG_KEY)) {
    // Candidate selection is a SHORT bypass transaction; generation — up to
    // one model call per (firm, client) — runs OUTSIDE it, same shape as the
    // digest sweep and for the same reason (a slow provider must not stall
    // the shared minute loop). Cross-instance idempotency rests on the unique
    // (firm_id, client_party_id, month_start) key.
    const monthStart = lagosMonthStart(1);
    const pairs = await runInBypassContext(async () => {
      const [{ locked }] = (
        await getDb().execute<{ locked: boolean }>(
          sql`SELECT pg_try_advisory_xact_lock(${STATEMENT_LOCK_ID}) AS locked`,
        )
      ).rows;
      if (!locked) return [];

      // A statement is owed to every client the firm actively serves: open or
      // in-progress engagements only, so archived clients stop accumulating
      // statements. selectDistinct because a client can have several
      // engagements with the same firm.
      return getDb()
        .selectDistinct({
          firmId: engagementsTable.firmId,
          clientPartyId: engagementsTable.clientPartyId,
        })
        .from(engagementsTable)
        .leftJoin(
          clerkClientStatementsTable,
          and(
            eq(clerkClientStatementsTable.firmId, engagementsTable.firmId),
            eq(
              clerkClientStatementsTable.clientPartyId,
              engagementsTable.clientPartyId,
            ),
            eq(clerkClientStatementsTable.monthStart, monthStart),
          ),
        )
        .where(
          and(
            sql`${engagementsTable.status} IN ('open', 'in_progress')`,
            isNull(clerkClientStatementsTable.id),
          ),
        )
        .limit(STATEMENT_BATCH);
    });
    if (pairs.length > 0) {
      // No provider configured (or kill switch off) still produces
      // statements — just from the template path.
      let gateway: ClerkGateway | null = null;
      try {
        gateway = await getClerkGateway();
      } catch {
        gateway = null;
      }
      let generated = 0;
      for (const pair of pairs) {
        await generateClientStatement(
          pair.firmId,
          pair.clientPartyId,
          monthStart,
          gateway,
        );
        generated += 1;
      }
      logger.info(
        { generated, monthStart },
        "client statement sweep: monthly statements generated",
      );
    }
  }

  // Delivery runs every pass — even when nothing was generated and even while
  // the generation flag is dark — so rows generated before delivery existed
  // (and stragglers from a bounded pass) are still offered. The delivered_at
  // compare-and-set keeps this idempotent across instances without the
  // generation lock.
  const delivered = await deliverClientStatements();
  if (delivered > 0) {
    logger.info(
      { delivered },
      "client statement sweep: statements offered to alert channels",
    );
  }
}

registerSweep(sweepClientStatements);
