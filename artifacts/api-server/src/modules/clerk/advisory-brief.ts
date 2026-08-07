import { desc, eq, and, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  getDb,
  clerkAdvisoryBriefsTable,
  partiesTable,
  type ClerkAdvisoryBriefRow,
  type ProtectedFact,
} from "@workspace/db";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { appendAudit } from "../audit/audit";
import { assertFirmClerkBudget } from "./budget";
import { ensureGrounded } from "./grounding";
import { CLERK_FLAG_KEY, inferPhrasing, type ClerkGateway } from "./gateway";
import { lagosMonthStart } from "./client-statement";
import { plural } from "./text";
import {
  countOpenFilings,
  openFilingSamples,
} from "../filings/filings";
import { countOpenObligations } from "../obligations/obligations";
import {
  filingDueDate,
  previousLagosPeriod,
} from "../filings/statutory-calendar";
import { computePenaltyExposure } from "../invoice/penalty-exposure";
import { computeCashflowOutlook, listChaseRows } from "../invoice/cashflow";
import { computeVatPosition } from "../invoice/vat-position";
import { listUnbilledIncome } from "../invoice/unbilled-income";
import { listMissingRecurringBills } from "../invoice/missing-bills";
import { listUnmatchedCredits } from "../invoice/unmatched-credits";
import { countClientUnmatchedCollections } from "../collections/unmatched";

// Advise with Clerk, Phase 1 (round 49): the per-client advisory brief —
// the month-end-close/compliance-pack COMPOSITION discipline applied to the
// firm's advisory work product. The rules, stated once:
//  - THIS MODULE CONTAINS ZERO PREDICATES OF ITS OWN. Every section reuses
//    the exact compute function its cited platform report serves
//    (countOpenFilings, computePenaltyExposure, computeCashflowOutlook,
//    computeVatPosition, the hygiene advisories) — a number in a brief is
//    BY CONSTRUCTION the number on the corresponding report, and a fix to
//    a source predicate fixes the brief with it.
//  - The model phrases ONLY the short adviser's-note lead-in (digest
//    posture: template fallback, number-grounded, firm-funded, `source`
//    records which path answered). The sections are never model text.
//  - One brief per (firm, client, LIVE Lagos month), REGENERATED in place:
//    unlike a statement (a closed month, generated once) the brief is an
//    "as of now" position — the natural unique key absorbs the upsert and
//    updatedAt records the refresh.
//  - Tenancy: the route layer owns scope (SEC-03 party pinning for client
//    readers; generation is firm-side engagement.write). This module only
//    verifies the engagement exists so a mistyped party id can never
//    mint a row for a stranger.
// Phase 2 adds the monthly sweep + delivery (the statement rail); Phase 3
// adds continuity and the advisory memory corpus.

export const BRIEF_PROMPT_VERSION = "advisory-brief.v1";

const BRIEF_SYSTEM = [
  "You write the short adviser's note that opens an accounting firm's monthly advisory brief to a Nigerian small-business client.",
  "Use ONLY the facts provided. Never invent amounts, dates, deadlines, rates or rules that are not in them; do not give legal advice.",
  "Lead with what most needs the client's attention; if nothing is overdue, say so plainly and point at what is coming.",
  "Tone: professional, plain, direct. The headline is one sentence; the note is 2 to 4 sentences. No greeting, no sign-off.",
  'Return JSON: {"headline": string, "note": string}.',
].join("\n");

const briefOutput = z.object({
  headline: z.string().min(1).max(200),
  note: z.string().min(1).max(1200),
});

const briefJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "note"],
  properties: {
    headline: { type: "string" },
    note: { type: "string" },
  },
};

// The closed section catalogue (contract key is an open string — append-only).
export interface AdvisoryBriefSection {
  key: "statutory" | "penalties" | "vat" | "money" | "hygiene";
  title: string;
  text: string;
  facts: ProtectedFact[];
  sourceReport: string;
}

const fact = (
  key: string,
  label: string,
  kind: ProtectedFact["kind"],
  value: string,
  unit?: string,
): ProtectedFact => ({ key, label, kind, value, ...(unit ? { unit } : {}) });

// Assemble the deterministic sections — one call per source report. The
// JS-clocked functions (VAT, money, hygiene) share ONE `now` (the
// net-position round-15 discipline); the SQL-clocked ones (filings,
// obligations, penalties) read the DB's Lagos today exactly as their own
// reports do — so every number still equals its report's, though a
// request straddling Lagos midnight can mix the two days across section
// families. Exported for tests.
export async function computeAdvisoryBriefSections(
  firmId: string,
  clientPartyId: string,
  now: Date = new Date(),
): Promise<AdvisoryBriefSection[]> {
  const sections: AdvisoryBriefSection[] = [];

  // --- Statutory position -----------------------------------------------
  const filings = await countOpenFilings(firmId, clientPartyId);
  const filingSamples = await openFilingSamples(firmId, clientPartyId, 3);
  const obligations = await countOpenObligations(firmId, clientPartyId);
  const statutoryText =
    filings.overdue + obligations.overdue > 0
      ? `${plural(filings.overdue + obligations.overdue, "statutory item")} ${
          filings.overdue + obligations.overdue === 1 ? "is" : "are"
        } overdue — clear these first.`
      : filings.dueSoon + obligations.dueSoon > 0
        ? `${plural(filings.dueSoon + obligations.dueSoon, "statutory item")} ${
            filings.dueSoon + obligations.dueSoon === 1 ? "falls" : "fall"
          } due within 7 days.`
        : "No statutory filings or notices are overdue.";
  sections.push({
    key: "statutory",
    title: "Statutory position",
    text: statutoryText,
    facts: [
      // Derived TOTALS ride as fact lines too (review R49-2): the section
      // text and the template headline lead with these sums, and the
      // grounding gate only accepts numerals present in buildBriefUser's
      // fact lines — a model phrasing the natural triage lead must not be
      // bounced for repeating the surface's own arithmetic.
      fact(
        "statutory_overdue_total",
        "Statutory items overdue (returns + notices)",
        "count",
        String(filings.overdue + obligations.overdue),
      ),
      fact(
        "statutory_due_soon_total",
        "Statutory items due within 7 days (returns + notices)",
        "count",
        String(filings.dueSoon + obligations.dueSoon),
      ),
      fact("unfiled", "Returns not yet filed", "count", String(filings.unfiled)),
      fact("filings_due_soon", "Returns due within 7 days", "count", String(filings.dueSoon)),
      fact("filings_overdue", "Returns overdue", "count", String(filings.overdue)),
      ...(filings.nextDueDate
        ? [fact("next_due", "Next return due", "date", filings.nextDueDate)]
        : []),
      fact("obligations_open", "Open authority notices", "count", String(obligations.open)),
      fact("obligations_overdue", "Notices past response deadline", "count", String(obligations.overdue)),
      ...filingSamples.slice(0, 3).map((s, i) =>
        fact(
          `open_filing_${i + 1}`,
          `${s.taxType.toUpperCase()} ${s.period}`,
          "text",
          `due ${s.dueDate} (${s.status})`,
        ),
      ),
    ],
    sourceReport: "Filings register & compliance calendar",
  });

  // --- Penalty exposure --------------------------------------------------
  const penalties = await computePenaltyExposure(firmId, clientPartyId);
  sections.push({
    key: "penalties",
    title: "Penalty exposure",
    text:
      penalties.overdueCount > 0
        ? `${plural(penalties.overdueCount, "invoice")} ${
            penalties.overdueCount === 1 ? "is" : "are"
          } past the statutory submission window — submitting them stops the exposure growing.`
        : "No invoices are past the statutory submission window.",
    facts: [
      fact("overdue_invoices", "Invoices past the window", "count", String(penalties.overdueCount)),
      fact("exposure_floor", "Exposure floor (small band)", "amount", penalties.exposure.small, "NGN"),
    ],
    sourceReport: "Penalty exposure report",
  });

  // --- VAT (last closed month) ------------------------------------------
  const vatPeriod = previousLagosPeriod(now);
  const vat = await computeVatPosition(
    firmId,
    clientPartyId,
    `${vatPeriod}-01`,
    now,
  );
  const vatDue = filingDueDate(vatPeriod, "vat");
  sections.push({
    key: "vat",
    title: `VAT — ${vat.monthLabel}`,
    text: `The ${vat.monthLabel} VAT return is due ${vatDue}.`,
    facts: [
      fact("output_vat", "Output VAT", "amount", vat.outputVat, "NGN"),
      fact("input_vat", "Input VAT", "amount", vat.inputVat, "NGN"),
      fact("input_vat_verified", "Input VAT (verified bills)", "amount", vat.inputVatVerified, "NGN"),
      fact("net_vat", "Net VAT position", "amount", vat.netVat, "NGN"),
      fact("vat_due", "Return due", "date", vatDue),
    ],
    sourceReport: "VAT position",
  });

  // --- Money position ----------------------------------------------------
  const outlook = await computeCashflowOutlook(firmId, clientPartyId, now);
  const chase = await listChaseRows(firmId, clientPartyId, now);
  // The dominant currency group (largest expected total) speaks for the
  // outlook; a multi-currency book keeps its full detail on the report.
  const group = [...outlook.groups].sort(
    (a, b) => Number(b.total.amount) - Number(a.total.amount),
  )[0];
  sections.push({
    key: "money",
    title: "Money position",
    text: group
      ? `${plural(group.total.count, "receivable")} outstanding${
          chase.length > 0
            ? `; ${plural(chase.length, "invoice")} ${chase.length === 1 ? "is" : "are"} late against the buyer's own payment rhythm and worth chasing.`
            : "."
        }`
      : "No outstanding receivables.",
    facts: group
      ? [
          fact("expected_total", "Expected inflows outstanding", "amount", group.total.amount, group.currency),
          fact("overdue_expected", "Past expected date", "amount", group.overdueExpected.amount, group.currency),
          fact("overdue_expected_count", "Invoices past expected date", "count", String(group.overdueExpected.count)),
          fact("chase_count", "Worth chasing now", "count", String(chase.length)),
        ]
      : [fact("expected_total", "Expected inflows outstanding", "count", "0")],
    sourceReport: "Cash-flow outlook & chase list",
  });

  // --- Books hygiene -----------------------------------------------------
  const unbilled = await listUnbilledIncome(firmId, clientPartyId, now);
  const missingBills = await listMissingRecurringBills(firmId, clientPartyId, now);
  const credits = await listUnmatchedCredits(firmId, clientPartyId, now);
  const unmatchedCollections = await countClientUnmatchedCollections(
    firmId,
    clientPartyId,
  );
  const hygieneAttention =
    unbilled.length + missingBills.length + credits.count + unmatchedCollections;
  sections.push({
    key: "hygiene",
    title: "Books hygiene",
    text:
      hygieneAttention > 0
        ? `${plural(hygieneAttention, "item")} in the books ${
            hygieneAttention === 1 ? "needs" : "need"
          } a look before month-end.`
        : "The books look clean — nothing is waiting on an explanation.",
    facts: [
      // The derived total leads for the same grounding reason as the
      // statutory sums (review R49-2).
      fact("hygiene_attention_total", "Books items needing attention", "count", String(hygieneAttention)),
      fact("unbilled_patterns", "Expected-but-unbilled income patterns", "count", String(unbilled.length)),
      fact("missing_bills", "Recurring bills not yet received", "count", String(missingBills.length)),
      fact("unmatched_credits", "Bank credits with no matching invoice", "count", String(credits.count)),
      ...(credits.count > 0
        ? [fact("unmatched_credits_total", "Unmatched credits total", "amount", credits.totalAmount, "NGN")]
        : []),
      fact("unmatched_collections", "Collection-rail payments unmatched", "count", String(unmatchedCollections)),
    ],
    sourceReport: "Month-end close advisories",
  });

  return sections;
}

// The deterministic fallback note — also what the grounding check compares
// against. Pure, exported for tests.
export function buildBriefTemplate(sections: AdvisoryBriefSection[]): {
  headline: string;
  note: string;
} {
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const factNum = (s: AdvisoryBriefSection | undefined, key: string): number =>
    Number(s?.facts.find((f) => f.key === key)?.value ?? 0);
  const statutory = byKey.get("statutory");
  // The DERIVED-TOTAL facts, not re-summed here: the headline's numeral
  // must be a numeral the grounding gate can find in a fact line, and the
  // due-soon triage counts notices exactly like the section text does.
  const overdue = factNum(statutory, "statutory_overdue_total");
  const dueSoon = factNum(statutory, "statutory_due_soon_total");
  const headline =
    overdue > 0
      ? `${plural(overdue, "statutory item")} ${overdue === 1 ? "is" : "are"} overdue — start there.`
      : dueSoon > 0
        ? `On track, with ${plural(dueSoon, "deadline")} inside the next 7 days.`
        : "You're on track this month: nothing statutory is overdue.";
  const note = sections
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join(" ");
  return { headline, note };
}

// The user prompt the model phrases — every line restates a section fact,
// so the grounding check has the numbers in front of it (the digest
// buildDigestUser shape). Pure, exported for the future phrasing-eval
// surface and tests.
export function buildBriefUser(sections: AdvisoryBriefSection[]): string {
  return [
    "Advisory facts for the client this month:",
    ...sections.flatMap((s) => [
      `${s.title}:`,
      ...s.facts.map(
        (f) => `- ${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ""}`,
      ),
    ]),
  ].join("\n");
}

async function assertEngagedClient(
  firmId: string,
  clientPartyId: string,
): Promise<void> {
  // LIVE engagements only (review R49-3): the statement sweep, filings
  // mint and every reminder rail scope to open/in_progress — an archived
  // or offboarded client must stop accumulating advisory work product
  // too, and Phase 2's delivery sweep claims on deliveredAt NULL, so a
  // brief minted here for an archived client would otherwise get
  // DELIVERED later.
  const rows = (
    await getDb().execute(sql`
      SELECT 1 FROM engagements
      WHERE firm_id = ${firmId}
        AND client_party_id = ${clientPartyId}
        AND status IN ('open', 'in_progress')
      LIMIT 1
    `)
  ).rows;
  if (rows.length === 0) {
    throw new DomainError("NOT_FOUND", "No such client engagement", 404);
  }
}

// Generate (or refresh) the LIVE month's brief for one client. Digest
// posture end to end: the template path always succeeds; the model only
// upgrades the note, and every failure mode (kill switch, budget, invalid
// output, ungrounded numeral, provider throw) stores the template with
// `source` tagged honestly.
export async function generateAdvisoryBrief(
  firmId: string,
  clientPartyId: string,
  gateway: ClerkGateway | null,
  generatedBy: string | null,
  now: Date = new Date(),
): Promise<ClerkAdvisoryBriefRow> {
  await assertEngagedClient(firmId, clientPartyId);
  const monthStart = lagosMonthStart(0, now);
  const sections = await computeAdvisoryBriefSections(
    firmId,
    clientPartyId,
    now,
  );
  const template = buildBriefTemplate(sections);
  let headline = template.headline;
  let note = template.note;
  let source: "clerk" | "template" = "template";

  let clerkAvailable =
    gateway !== null && (await isFeatureEnabled(CLERK_FLAG_KEY));
  if (clerkAvailable) {
    try {
      await assertFirmClerkBudget(firmId);
    } catch {
      clerkAvailable = false;
    }
  }
  if (clerkAvailable && gateway) {
    const user = buildBriefUser(sections);
    try {
      const data = await inferPhrasing<z.infer<typeof briefOutput>>(gateway, {
        purpose: "advisory_brief",
        firmId,
        promptVersion: BRIEF_PROMPT_VERSION,
        system: BRIEF_SYSTEM,
        user,
        schemaName: "advisory_brief",
        jsonSchema: briefJsonSchema,
        validator: briefOutput,
        inputForHash: `${firmId}:${clientPartyId}:${monthStart}:${JSON.stringify(sections)}`,
      });
      if (
        data &&
        (await ensureGrounded(
          "advisory_brief",
          firmId,
          `${data.headline}\n${data.note}`,
          user,
        ))
      ) {
        headline = data.headline;
        note = data.note;
        source = "clerk";
      }
    } catch {
      // The template note stands; the row below stores it as-is.
    }
  }

  const [row] = await getDb()
    .insert(clerkAdvisoryBriefsTable)
    .values({
      firmId,
      clientPartyId,
      monthStart,
      sections: sections as unknown as Record<string, unknown>[],
      headline,
      note,
      source,
      generatedBy,
    })
    .onConflictDoUpdate({
      target: [
        clerkAdvisoryBriefsTable.firmId,
        clerkAdvisoryBriefsTable.clientPartyId,
        clerkAdvisoryBriefsTable.monthStart,
      ],
      set: {
        sections: sections as unknown as Record<string, unknown>[],
        headline,
        note,
        source,
        generatedBy,
        updatedAt: new Date(),
      },
    })
    .returning();
  await appendAudit({
    actorId: generatedBy,
    firmId,
    action: "advisory.brief.generate",
    entityType: "clerk_advisory_brief",
    entityId: row.id,
    after: { clientPartyId, monthStart, source },
  });
  return row;
}

// Read path: newest first, the client's legal name joined for display.
export async function listAdvisoryBriefs(
  firmId: string,
  clientPartyId: string,
  limit = 12,
): Promise<(ClerkAdvisoryBriefRow & { clientName: string })[]> {
  const rows = await getDb()
    .select({
      brief: clerkAdvisoryBriefsTable,
      clientName: partiesTable.legalName,
    })
    .from(clerkAdvisoryBriefsTable)
    .innerJoin(
      partiesTable,
      eq(partiesTable.id, clerkAdvisoryBriefsTable.clientPartyId),
    )
    .where(
      and(
        eq(clerkAdvisoryBriefsTable.firmId, firmId),
        eq(clerkAdvisoryBriefsTable.clientPartyId, clientPartyId),
      ),
    )
    .orderBy(desc(clerkAdvisoryBriefsTable.monthStart))
    .limit(limit);
  return rows.map((r) => ({ ...r.brief, clientName: r.clientName }));
}
