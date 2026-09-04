import { and, desc, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import {
  getDb,
  clerkCasesTable,
  clerkEvalFixturesTable,
  invoicesTable,
  partiesTable,
  type ClerkCase,
} from "@workspace/db";
import type { EvalFixture } from "./eval-fixtures";

// The learning loop (Clerk expansion B). Every approval where the operator
// corrected the model's proposal already leaves labeled ground truth on the
// case (corrections: extracted vs final, per field). This module turns that
// exhaust into eval fixtures — the document text plus the human-approved
// values. `eval-sweep.ts` owns scheduling and the optional token-spending
// nightly run, keeping this corpus repository independent of the eval runner.

const GROWTH_BATCH = 20;

// Notice corrections record the operator's approved OBLIGATION values, and
// for these two fields those are contract catalogue KEYS ("firs", "vat"),
// not what the letter prints ("Federal Inland Revenue Service", "Value
// Added Tax") — the mapping is the operator's work, not the extractor's.
// The eval runner replays the verbatim notice prompt, so a key-mapped
// expectation could never match a correct extraction: a fixture carrying
// one would fail forever, dragging blended accuracy and (authority being a
// critical field) faking non-resistance. Drop them at growth; the scorer's
// skip-absent-expectations rule does the rest.
const NOTICE_KEY_MAPPED_FIELDS: ReadonlySet<string> = new Set([
  "authority",
  "taxType",
]);

// Pure: an approved, corrected case → a ground-truth fixture, or null when the
// case can't serve as one (no text source, or nothing was compared). The
// expected values are the operator's FINAL values for every compared field —
// including the ones the model already had right (final === extracted) —
// minus, on notice cases, the catalogue-key fields above.
export function fixtureFromCase(
  kase: Pick<
    ClerkCase,
    "id" | "kind" | "sourceName" | "sourceText" | "corrections" | "status"
  >,
): {
  caseId: string;
  label: string;
  sourceText: string;
  expected: Record<string, string | null>;
} | null {
  if (kase.status !== "approved") return null;
  if (!kase.sourceText || !kase.corrections?.length) return null;
  const expected: Record<string, string | null> = {};
  for (const c of kase.corrections) {
    if (kase.kind === "notice" && NOTICE_KEY_MAPPED_FIELDS.has(c.field)) {
      continue;
    }
    expected[c.field] = c.final;
  }
  if (Object.keys(expected).length === 0) return null;
  return {
    caseId: kase.id,
    label: kase.sourceName ?? `case ${kase.id.slice(0, 8)}`,
    sourceText: kase.sourceText,
    expected,
  };
}

// Fixture rows → the EvalFixture shape the runner scores. The corpus is
// CAPPED at the most recent fixtures: growth is unbounded (one per corrected
// approval, forever), and every fixture is one model call per eval run — an
// uncapped corpus makes the nightly run's cost and duration grow without
// limit. Recent corrections are also the ones most representative of the
// current document mix. Exported for the curation inventory
// (eval-curation.ts), which must show exactly the corpus this loader runs.
export const GROWN_CORPUS_CAP = 200;

export async function loadGrownFixtures(
  limit = GROWN_CORPUS_CAP,
): Promise<EvalFixture[]> {
  // Retired fixtures are excluded BEFORE the newest-N cap (a WHERE, not a
  // post-filter), so retiring a fixture frees its corpus slot for the next
  // most recent correction instead of silently shrinking the run.
  const rows = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(isNull(clerkEvalFixturesTable.retiredAt))
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(limit);
  rows.reverse(); // oldest-first, matching the previous stable run order
  return rows.map((r) => ({
    key: `correction.${r.caseId.slice(0, 8)}`,
    label: r.label,
    riskLabel: "correction" as const,
    // The stored kind routes the fixture to its lane in the runner: notice
    // fixtures replay the extract_notice prompt and score over the notice
    // catalogue; everything else stays on the historic invoice path.
    kind: r.kind === "notice" ? ("notice" as const) : ("invoice" as const),
    sourceText: r.sourceText,
    expected: r.expected as EvalFixture["expected"],
  }));
}

// Turn newly corrected approvals into fixtures (one per case, capped per
// pass). Both document lanes grow the same way — an approved invoice
// extraction and an approved notice reading each leave corrections — and the
// case's kind rides onto the fixture so the runner replays it on the right
// prompt. Insert races resolve on the caseId unique constraint. The approved
// invoice's supplier party identity (register name/TIN, never extracted
// strings — corrections exclude party identity by design) rides onto the
// fixture so supplier memory (exemplar.ts) can match future documents;
// notice cases create no invoice, so their identity columns stay null and
// supplier memory never serves them.
export async function growEvalFixtures(
  limit = GROWTH_BATCH,
): Promise<number> {
  const candidates = await getDb()
    .select({
      id: clerkCasesTable.id,
      kind: clerkCasesTable.kind,
      sourceName: clerkCasesTable.sourceName,
      sourceText: clerkCasesTable.sourceText,
      corrections: clerkCasesTable.corrections,
      status: clerkCasesTable.status,
      supplierName: partiesTable.legalName,
      supplierTin: partiesTable.tin,
    })
    .from(clerkCasesTable)
    .leftJoin(
      clerkEvalFixturesTable,
      eq(clerkEvalFixturesTable.caseId, clerkCasesTable.id),
    )
    .leftJoin(
      invoicesTable,
      eq(invoicesTable.id, clerkCasesTable.createdInvoiceId),
    )
    .leftJoin(partiesTable, eq(partiesTable.id, invoicesTable.supplierPartyId))
    .where(
      and(
        inArray(clerkCasesTable.kind, ["extraction", "notice"]),
        eq(clerkCasesTable.status, "approved"),
        isNotNull(clerkCasesTable.sourceText),
        isNotNull(clerkCasesTable.corrections),
        isNull(clerkEvalFixturesTable.id),
      ),
    )
    .limit(limit);

  let grown = 0;
  for (const candidate of candidates) {
    const fixture = fixtureFromCase(candidate);
    if (!fixture) continue;
    const inserted = await getDb()
      .insert(clerkEvalFixturesTable)
      .values({
        ...fixture,
        kind: candidate.kind === "notice" ? "notice" : "invoice",
        supplierName: candidate.supplierName ?? null,
        supplierTin: candidate.supplierTin ?? null,
      })
      .onConflictDoNothing({ target: clerkEvalFixturesTable.caseId })
      .returning({ id: clerkEvalFixturesTable.id });
    grown += inserted.length;
  }
  return grown;
}
