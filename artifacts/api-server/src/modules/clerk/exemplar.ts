import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  clerkEvalFixturesTable,
} from "@workspace/db";
import { logger } from "../../lib/logger";

// Supplier memory (exhaust idea #1). The learning loop already turns every
// corrected approval into a ground-truth fixture (eval-growth.ts): the
// document text plus the operator's final values — and, since corrections
// deliberately exclude party identity, the growth sweep stamps the APPROVED
// invoice's supplier party name/TIN onto the fixture as dedicated columns.
// The same supplier's invoices look alike month after month, yet extraction
// reads each one cold — so when a new document DETERMINISTICALLY matches a
// fixture's approved supplier identity, that fixture rides along as a
// one-shot example.
//
// The guardrails, stated once:
//  - SAME FIRM ONLY (join on the case's firmId), and for CLIENT-initiated
//    captures the pool narrows further to fixtures from cases the same user
//    created — firm-keyed sharing is not sufficient between sibling clients
//    (SEC-03), and a fixture is client document content.
//  - THE APP PICKS, never the model: exact-TIN containment (8+ chars)
//    outranks name-token containment; within a pass, newest fixture wins;
//    weak evidence (fewer than two meaningful name tokens) matches nothing.
//  - PROPOSE/DISPOSE UNTOUCHED. The exemplar only changes what the extractor
//    sees; every value still walks normalization, flagging, pre-flight and
//    human review, and the ledger records the variant prompt version so the
//    corrected-rate of exemplar extractions is measurable on its own. The
//    system prompt orders the model never to copy example values the new
//    document does not show, and the register pre-flight independently
//    cross-checks identities downstream.
//  - EXPLICIT BYPASS POSTURE: fixtures are bypass-only by design (migration
//    0010 — no firm principal may read another firm's corrected documents),
//    so this lookup runs in a bypass scope with the firm/creator filters
//    enforced HERE, like the gateway's ledger writes. A tenant-scoped
//    context would silently return nothing.
//  - BEST-EFFORT. Any lookup failure means "no exemplar", never a blocked
//    intake.

const EXEMPLAR_SCAN_LIMIT = 200;
// Exemplar hygiene (round-7 idea #2): an exemplar only earns its ride-along
// if the cases it accompanied were actually kept. Every extraction records
// its exemplarCaseId and every approval records per-field corrections — so
// an exemplar whose descendant approvals get most of their fields overridden
// is demonstrably misleading and is skipped (the next candidate, or cold
// extraction, takes over). Thresholds are conservative: judgment needs real
// history, and an occasional bad descendant should not kill a good exemplar.
export const HYGIENE_MIN_CASES = 3;
export const HYGIENE_MAX_OVERRIDE_RATE = 0.5;
// Below this many characters a "document" is a text snippet whose token
// overlap says little; skip rather than match noise.
const MIN_DOC_CHARS = 40;
// TIN containment scans a separator-stripped blob, where short digit runs
// can appear by accident inside amounts or dates; 8+ characters is needed
// before containment counts as identity evidence.
const MIN_TIN_CHARS = 8;

export interface ExtractionExemplar {
  caseId: string;
  sourceText: string;
  expected: Record<string, string | null>;
}

interface SupplierIdentity {
  supplierName: string | null;
  supplierTin: string | null;
}

function normalizeBlob(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTin(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Mirrors party-match.ts: legal-form suffixes carry no identity.
const GENERIC_TOKENS = new Set([
  "LTD",
  "LIMITED",
  "PLC",
  "CO",
  "COMPANY",
  "ENTERPRISES",
  "ENTERPRISE",
  "VENTURES",
  "AND",
  "THE",
  "OF",
]);

function nameTokens(name: string): string[] {
  return name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

// TIN containment: near-unique evidence the document is this supplier's.
export function matchesSupplierTin(
  docBlob: string,
  identity: SupplierIdentity,
): boolean {
  const tin = normalizeTin(identity.supplierTin);
  return tin.length >= MIN_TIN_CHARS && docBlob.includes(tin);
}

// Name containment: every meaningful token (at least two) must appear.
export function matchesSupplierName(
  docBlob: string,
  identity: SupplierIdentity,
): boolean {
  if (!identity.supplierName) return false;
  const tokens = nameTokens(identity.supplierName);
  if (tokens.length < 2) return false;
  return tokens.every((t) => docBlob.includes(t));
}

export interface ExemplarDescendantStats {
  exemplarCaseId: string;
  cases: number;
  fieldsCompared: number;
  fieldsChanged: number;
}

// Pure demotion rule, exported for tests: enough descendant history AND a
// high override rate = demoted.
export function demotedExemplars(
  stats: ExemplarDescendantStats[],
): Set<string> {
  const demoted = new Set<string>();
  for (const s of stats) {
    if (
      s.cases >= HYGIENE_MIN_CASES &&
      s.fieldsCompared > 0 &&
      s.fieldsChanged / s.fieldsCompared >= HYGIENE_MAX_OVERRIDE_RATE
    ) {
      demoted.add(s.exemplarCaseId);
    }
  }
  return demoted;
}

// Descendant correction stats for a candidate set, one SQL pass. Runs in the
// caller's bypass scope; the candidate ids came from the firm-filtered
// fixture query, so no cross-firm id can enter the list.
async function descendantStats(
  exemplarCaseIds: string[],
): Promise<ExemplarDescendantStats[]> {
  if (exemplarCaseIds.length === 0) return [];
  const rows = (
    await getDb().execute<{
      exemplar_id: string;
      cases: number;
      fields: number;
      changed: number;
    }>(sql`
      SELECT extraction->>'exemplarCaseId' AS exemplar_id,
        COUNT(*)::int AS cases,
        COALESCE(SUM(jsonb_array_length(corrections)), 0)::int AS fields,
        COALESCE(SUM((
          SELECT COUNT(*) FROM jsonb_array_elements(corrections) c
          WHERE (c->>'changed')::boolean
        )), 0)::int AS changed
      FROM clerk_cases
      WHERE status = 'approved'
        AND corrections IS NOT NULL
        AND extraction->>'exemplarCaseId' IN (${sql.join(
          exemplarCaseIds.map((id) => sql`${id}`),
          sql`, `,
        )})
      GROUP BY 1
    `)
  ).rows;
  return rows.map((r) => ({
    exemplarCaseId: r.exemplar_id,
    cases: Number(r.cases),
    fieldsCompared: Number(r.fields),
    fieldsChanged: Number(r.changed),
  }));
}

// The newest same-firm fixture whose approved supplier identity appears in
// the new document's text — TIN evidence outranks name evidence across the
// whole pool. Text sources only; `restrictToCreator` narrows the pool to one
// user's own cases for client-initiated captures (SEC-03).
export async function findExtractionExemplar(
  sourceText: string,
  firmId: string,
  restrictToCreator: string | null = null,
): Promise<ExtractionExemplar | null> {
  if (sourceText.length < MIN_DOC_CHARS) return null;
  try {
    const fixtures = await runInBypassContext(() =>
      getDb()
        .select({
          caseId: clerkEvalFixturesTable.caseId,
          sourceText: clerkEvalFixturesTable.sourceText,
          expected: clerkEvalFixturesTable.expected,
          supplierName: clerkEvalFixturesTable.supplierName,
          supplierTin: clerkEvalFixturesTable.supplierTin,
        })
        .from(clerkEvalFixturesTable)
        .innerJoin(
          clerkCasesTable,
          eq(clerkCasesTable.id, clerkEvalFixturesTable.caseId),
        )
        .where(
          and(
            eq(clerkCasesTable.firmId, firmId),
            ...(restrictToCreator
              ? [eq(clerkCasesTable.createdBy, restrictToCreator)]
              : []),
          ),
        )
        .orderBy(desc(clerkEvalFixturesTable.createdAt))
        .limit(EXEMPLAR_SCAN_LIMIT),
    );
    const docBlob = normalizeBlob(sourceText);
    const tinHits = fixtures.filter((f) => matchesSupplierTin(docBlob, f));
    const nameHits = fixtures.filter((f) => matchesSupplierName(docBlob, f));
    const candidates = [...tinHits, ...nameHits];
    if (candidates.length === 0) return null;

    // Hygiene: skip candidates whose descendant approvals were heavily
    // overridden — an exemplar the exhaust has proven misleading. The stats
    // query runs only when something matched, and only over the matches.
    const demoted = demotedExemplars(
      await runInBypassContext(() =>
        descendantStats([...new Set(candidates.map((c) => c.caseId))]),
      ),
    );
    const hit = candidates.find((c) => !demoted.has(c.caseId));
    if (!hit) return null;
    return {
      caseId: hit.caseId,
      sourceText: hit.sourceText,
      expected: hit.expected,
    };
  } catch (err) {
    logger.warn({ err, firmId }, "exemplar lookup failed; extracting cold");
    return null;
  }
}
