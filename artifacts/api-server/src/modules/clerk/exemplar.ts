import { and, desc, eq } from "drizzle-orm";
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
    const hit =
      fixtures.find((f) => matchesSupplierTin(docBlob, f)) ??
      fixtures.find((f) => matchesSupplierName(docBlob, f));
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
