import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  clerkCasesTable,
  clerkEvalFixturesTable,
  clerkEvalRunsTable,
  clerkRedTeamFixturesTable,
  invoicesTable,
  membershipsTable,
  obligationsTable,
  partiesTable,
  type ClerkEvalFixtureResult,
} from "@workspace/db";
import { appendAudit } from "../audit/audit";
import { DomainError } from "../errors";
import { creatorClientParty } from "./cases";
import { EVAL_FIXTURES, NOTICE_EVAL_FIXTURES } from "./eval-fixtures";
import { GROWN_CORPUS_CAP } from "./eval-growth";
import { RED_TEAM_CORPUS_CAP } from "./red-team";
import { createScrubber } from "./scrub";

// Eval corpus curation (round 15). The corpus grows on two automatic rails —
// corrected approvals (eval-growth.ts) and generated attacks (red-team.ts) —
// but until now nothing let an operator SEE what accumulated or prune a
// fixture that keeps failing for reasons that aren't the model's fault (a
// mis-corrected approval, a nonsense OCR document, a red-team variant whose
// decoys aged badly). This module is that curation surface:
//
//  - listEvalFixtures(): the full corpus inventory — static, grown and
//    red-team — with each fixture's pass history reconstructed by scanning
//    the newest stored eval runs (the append-only evidence; nothing new is
//    stored). Retired fixtures are listed and flagged, so the pruning
//    decision stays reviewable.
//  - retireFixture()/restoreFixture(): flip the retiredAt marker the corpus
//    loaders exclude BEFORE their newest-N caps (retirement frees a slot).
//    The fixture ROW is never deleted — past runs keep their meaning — and
//    static fixtures can never be retired: they are the hand-written
//    regression floor every run must keep measuring.
//  - mintFixtureFromCase() (round 7): an operator promotes a decided case
//    into the grown corpus by hand, with the document text pseudonymized
//    (scrub.ts) whenever the case is traceable to a live client. Scrubbing
//    applies to THIS flow only — sweep-grown fixtures (eval-growth.ts) stay
//    verbatim on purpose, because that table doubles as the supplier-memory
//    exemplar store and scrubbed text would break exemplar matching.
//  - retireFixturesForClientParty() (round 7): the offboarding hook — grown
//    fixtures traced to an offboarded client are retired AND content-nulled,
//    so no client document text outlives the relationship inside the corpus.
//
// Everything here is deterministic SQL + in-memory assembly; zero model calls.

// How many recent runs the history reconstruction scans. Each run's results
// jsonb carries one entry per fixture, so this bounds both the query and the
// assembly regardless of how long the platform has been running evals.
const RUN_SCAN_CAP = 50;

export type EvalFixtureSource = "static" | "grown" | "redteam";

// Key prefixes are the loaders' own key scheme: a grown fixture is
// `correction.<first 8 of caseId>` (eval-growth.ts), a red-team variant is
// `redteam.<first 8 of id>` (red-team.ts). Static keys are whatever
// eval-fixtures.ts hand-wrote (e.g. "clean.standard").
const GROWN_KEY_PREFIX = "correction.";
const RED_TEAM_KEY_PREFIX = "redteam.";

export interface EvalFixtureSummary {
  key: string;
  source: EvalFixtureSource;
  label: string;
  riskLabel: string;
  retired: boolean;
  retiredAt: string | null;
  createdAt: string | null;
  // History reconstructed from the scanned runs (field NAMES only — a
  // mismatch's expected/actual values are fixture content and stay in the
  // run rows, never in this inventory).
  runs: number;
  lastOutcome: string | null;
  fieldsCompared: number;
  fieldsCorrect: number;
  injectionFixtures: number;
  injectionResisted: number;
  lastMismatchedFields: string[];
}

export interface EvalFixtureReport {
  fixtures: EvalFixtureSummary[];
  runsScanned: number;
}

interface FixtureHistory {
  runs: number;
  lastOutcome: string | null;
  fieldsCompared: number;
  fieldsCorrect: number;
  injectionFixtures: number;
  injectionResisted: number;
  lastMismatchedFields: string[];
}

const EMPTY_HISTORY: FixtureHistory = {
  runs: 0,
  lastOutcome: null,
  fieldsCompared: 0,
  fieldsCorrect: 0,
  injectionFixtures: 0,
  injectionResisted: 0,
  lastMismatchedFields: [],
};

// Fold the scanned runs (newest first) into per-key cumulative history. The
// first appearance of a key is its newest, so lastOutcome and
// lastMismatchedFields come from that entry; everything else accumulates.
function reconstructHistory(
  runs: Array<{ results: ClerkEvalFixtureResult[] }>,
): Map<string, FixtureHistory> {
  const byKey = new Map<string, FixtureHistory>();
  for (const run of runs) {
    for (const result of run.results) {
      let history = byKey.get(result.key);
      if (!history) {
        history = {
          ...EMPTY_HISTORY,
          lastOutcome: result.outcome,
          lastMismatchedFields: result.mismatches.map((m) => m.field),
        };
        byKey.set(result.key, history);
      }
      history.runs += 1;
      history.fieldsCompared += result.fieldsCompared;
      history.fieldsCorrect += result.fieldsCorrect;
      if (result.injectionResisted !== null) {
        history.injectionFixtures += 1;
        if (result.injectionResisted) history.injectionResisted += 1;
      }
    }
  }
  return byKey;
}

export async function listEvalFixtures(): Promise<EvalFixtureReport> {
  const db = getDb();

  // The ACTIVE side of each stored corpus is exactly what the loaders run:
  // newest-N unretired (same order, same cap). Retired rows are listed in
  // full — they are operator-curated and stay visible for restore.
  const grownActive = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(isNull(clerkEvalFixturesTable.retiredAt))
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(GROWN_CORPUS_CAP);
  const grownRetired = await db
    .select()
    .from(clerkEvalFixturesTable)
    .where(isNotNull(clerkEvalFixturesTable.retiredAt))
    .orderBy(desc(clerkEvalFixturesTable.createdAt));
  const redActive = await db
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(isNull(clerkRedTeamFixturesTable.retiredAt))
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt))
    .limit(RED_TEAM_CORPUS_CAP);
  const redRetired = await db
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(isNotNull(clerkRedTeamFixturesTable.retiredAt))
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt));

  const runs = await db
    .select({ results: clerkEvalRunsTable.results })
    .from(clerkEvalRunsTable)
    .orderBy(desc(clerkEvalRunsTable.createdAt))
    .limit(RUN_SCAN_CAP);
  const history = reconstructHistory(runs);

  const withHistory = (
    base: Omit<EvalFixtureSummary, keyof FixtureHistory>,
  ): EvalFixtureSummary => ({
    ...base,
    ...(history.get(base.key) ?? EMPTY_HISTORY),
  });

  const fixtures: EvalFixtureSummary[] = [
    // Both static lanes: the invoice corpus and the notice corpus (round 30)
    // — the inventory must show exactly what the full-corpus run measures.
    ...[...EVAL_FIXTURES, ...NOTICE_EVAL_FIXTURES].map((f) =>
      withHistory({
        key: f.key,
        source: "static",
        label: f.label,
        riskLabel: f.riskLabel,
        retired: false,
        retiredAt: null,
        createdAt: null,
      }),
    ),
    ...[...grownActive, ...grownRetired].map((r) =>
      withHistory(grownSummaryBase(r)),
    ),
    ...[...redActive, ...redRetired].map((r) =>
      withHistory(redTeamSummaryBase(r)),
    ),
  ];

  return { fixtures, runsScanned: runs.length };
}

type GrownRow = typeof clerkEvalFixturesTable.$inferSelect;
type RedTeamRow = typeof clerkRedTeamFixturesTable.$inferSelect;

// Row → summary base, using the SAME key/label scheme as the loaders so the
// inventory's keys line up with the keys stored in every run's results.
function grownSummaryBase(
  row: GrownRow,
): Omit<EvalFixtureSummary, keyof FixtureHistory> {
  return {
    key: `${GROWN_KEY_PREFIX}${row.caseId.slice(0, 8)}`,
    source: "grown",
    label: row.label,
    riskLabel: "correction",
    retired: row.retiredAt !== null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function redTeamSummaryBase(
  row: RedTeamRow,
): Omit<EvalFixtureSummary, keyof FixtureHistory> {
  return {
    key: `${RED_TEAM_KEY_PREFIX}${row.id.slice(0, 8)}`,
    source: "redteam",
    label: `red team: ${row.strategy} (from ${row.baseKey})`,
    riskLabel: "injection",
    retired: row.retiredAt !== null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// Map a fixture key back to its stored row. The key embeds only the first 8
// hex chars of the underlying uuid, so the lookup matches on that prefix —
// unique in practice (the loaders would collide on display before we would
// here) and newest-first so a freak collision resolves deterministically.
async function findGrownRow(idPrefix: string): Promise<GrownRow | null> {
  const [row] = await getDb()
    .select()
    .from(clerkEvalFixturesTable)
    .where(sql`left(${clerkEvalFixturesTable.caseId}::text, 8) = ${idPrefix}`)
    .orderBy(desc(clerkEvalFixturesTable.createdAt))
    .limit(1);
  return row ?? null;
}

async function findRedTeamRow(idPrefix: string): Promise<RedTeamRow | null> {
  const [row] = await getDb()
    .select()
    .from(clerkRedTeamFixturesTable)
    .where(sql`left(${clerkRedTeamFixturesTable.id}::text, 8) = ${idPrefix}`)
    .orderBy(desc(clerkRedTeamFixturesTable.createdAt))
    .limit(1);
  return row ?? null;
}

function assertNotStatic(key: string): void {
  if (
    EVAL_FIXTURES.some((f) => f.key === key) ||
    NOTICE_EVAL_FIXTURES.some((f) => f.key === key)
  ) {
    throw new DomainError(
      "STATIC_FIXTURE",
      "Static fixtures are the hand-written regression floor and cannot be retired",
      400,
    );
  }
}

async function setRetired(
  key: string,
  actorId: string,
  retire: boolean,
): Promise<EvalFixtureSummary> {
  assertNotStatic(key);
  const action = retire ? "clerk.eval.fixture.retire" : "clerk.eval.fixture.restore";

  if (key.startsWith(GROWN_KEY_PREFIX)) {
    const row = await findGrownRow(key.slice(GROWN_KEY_PREFIX.length));
    if (!row) throw new DomainError("NOT_FOUND", "Fixture not found", 404);
    // Idempotent: retiring keeps the original retirement timestamp.
    const retiredAt = retire ? (row.retiredAt ?? new Date()) : null;
    const [updated] = await getDb()
      .update(clerkEvalFixturesTable)
      .set({ retiredAt })
      .where(sql`${clerkEvalFixturesTable.id} = ${row.id}`)
      .returning();
    await appendAudit({
      actorId,
      action,
      entityType: "clerk_eval_fixture",
      entityId: row.id,
      before: { retiredAt: row.retiredAt?.toISOString() ?? null },
      after: { key, retiredAt: retiredAt?.toISOString() ?? null },
    });
    return { ...grownSummaryBase(updated), ...EMPTY_HISTORY };
  }

  if (key.startsWith(RED_TEAM_KEY_PREFIX)) {
    const row = await findRedTeamRow(key.slice(RED_TEAM_KEY_PREFIX.length));
    if (!row) throw new DomainError("NOT_FOUND", "Fixture not found", 404);
    const retiredAt = retire ? (row.retiredAt ?? new Date()) : null;
    const [updated] = await getDb()
      .update(clerkRedTeamFixturesTable)
      .set({ retiredAt })
      .where(sql`${clerkRedTeamFixturesTable.id} = ${row.id}`)
      .returning();
    await appendAudit({
      actorId,
      action,
      entityType: "clerk_red_team_fixture",
      entityId: row.id,
      before: { retiredAt: row.retiredAt?.toISOString() ?? null },
      after: { key, retiredAt: retiredAt?.toISOString() ?? null },
    });
    return { ...redTeamSummaryBase(updated), ...EMPTY_HISTORY };
  }

  // Neither a known static key nor a curatable prefix.
  throw new DomainError("NOT_FOUND", "Fixture not found", 404);
}

export async function retireFixture(
  key: string,
  actorId: string,
): Promise<EvalFixtureSummary> {
  return setRetired(key, actorId, true);
}

export async function restoreFixture(
  key: string,
  actorId: string,
): Promise<EvalFixtureSummary> {
  return setRetired(key, actorId, false);
}

// ---- Mint a fixture from a decided case (round 7) --------------------------
// POST /clerk/eval/fixtures/from-case. The sweep grows fixtures only from
// corrected APPROVALS; this lets an operator promote any decided case — a
// rejected forgery, an approval whose document is worth pinning — with the
// pseudonymization the automatic path deliberately lacks (see module header).
//
// Ground truth: the corrections' FINAL values when the approval recorded a
// diff (same rule as fixtureFromCase in eval-growth.ts), else the
// extraction's CRITICAL fields — a rejected case has no corrections, but its
// extraction still pins what the document printed.
//
// Traceability rule: a case is traceable to a live client when its created
// invoice names a supplier party OR its creator is a client_user (the
// eval-growth join precedent plus creatorClientParty). A traceable case may
// only enter the corpus scrubbed — scrub=false is refused with
// SCRUB_REQUIRED, never silently honoured.

export interface MintFixtureFromCaseInput {
  caseId: string;
  // Pseudonymize known party identities in the stored text. Defaults TRUE;
  // false is only accepted for cases with no client trace at all.
  scrub?: boolean;
}

export async function mintFixtureFromCase(
  input: MintFixtureFromCaseInput,
  actorId: string,
): Promise<EvalFixtureSummary> {
  const scrub = input.scrub !== false;
  // Bypass context throughout: clerk_cases and the fixture tables are
  // bypass-only RLS (migrations 0005/0010), and the mint route runs on the
  // ordinary request transaction whose posture depends on the principal.
  return runInBypassContext(async () => {
    const [kase] = await getDb()
      .select()
      .from(clerkCasesTable)
      .where(eq(clerkCasesTable.id, input.caseId))
      .limit(1);
    if (!kase || kase.kind !== "extraction") {
      throw new DomainError("NOT_FOUND", "Extraction case not found", 404);
    }
    if (kase.status !== "approved" && kase.status !== "rejected") {
      throw new DomainError(
        "NOT_DECIDED",
        `Only decided (approved/rejected) cases can become fixtures (status is '${kase.status}')`,
        409,
      );
    }
    // Vision/scan/image cases are out of scope THIS round: the minted corpus
    // is text fixtures (the vision lane is the deterministic synthetic corpus
    // in vision-fixtures.ts, never client scans).
    if (
      kase.sourceType === "image" ||
      kase.sourceImageB64 !== null ||
      (kase.sourceScanPagesB64?.length ?? 0) > 0
    ) {
      throw new DomainError(
        "TEXT_ONLY",
        "Only text-source cases can be promoted into the eval corpus this round",
        400,
      );
    }
    if (!kase.sourceText) {
      throw new DomainError(
        "CONTENT_PURGED",
        "This case's document content was purged by the retention sweep; it can no longer become a fixture",
        400,
      );
    }
    // Fast-fail the common already-a-fixture case with a clear 409 (the
    // caseId unique constraint backstops the insert race below).
    const [existing] = await getDb()
      .select({ id: clerkEvalFixturesTable.id })
      .from(clerkEvalFixturesTable)
      .where(eq(clerkEvalFixturesTable.caseId, kase.id))
      .limit(1);
    if (existing) {
      throw new DomainError(
        "ALREADY_FIXTURE",
        "This case is already in the eval corpus",
        409,
      );
    }

    // Ground truth (see the header note on the corrections-else-criticals rule).
    const expected: Record<string, string | null> = {};
    if (kase.corrections?.length) {
      for (const c of kase.corrections) expected[c.field] = c.final;
    } else if (kase.extraction) {
      for (const f of kase.extraction.fields) {
        if (f.critical) expected[f.field] = f.value;
      }
    } else {
      throw new DomainError(
        "NO_GROUND_TRUTH",
        "The case has neither corrections nor an extraction to pin expected values from",
        400,
      );
    }

    // Traceability: invoice supplier (eval-growth join precedent) or a
    // client_user creator.
    let invoiceSupplierPartyId: string | null = null;
    let invoiceBuyerPartyId: string | null = null;
    if (kase.createdInvoiceId) {
      const [invoice] = await getDb()
        .select({
          supplierPartyId: invoicesTable.supplierPartyId,
          buyerPartyId: invoicesTable.buyerPartyId,
        })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, kase.createdInvoiceId))
        .limit(1);
      invoiceSupplierPartyId = invoice?.supplierPartyId ?? null;
      invoiceBuyerPartyId = invoice?.buyerPartyId ?? null;
    }
    const creatorParty = await creatorClientParty(kase.createdBy);
    const traceable = invoiceSupplierPartyId !== null || creatorParty !== null;
    if (traceable && !scrub) {
      throw new DomainError(
        "SCRUB_REQUIRED",
        "This case is traceable to a live client; it can only enter the corpus pseudonymized (scrub=true)",
        400,
      );
    }

    let sourceText = kase.sourceText;
    let scrubbedExpected = expected;
    let replacements = 0;
    if (scrub) {
      // Identities the platform can NAME for this case: the expected and
      // extracted supplier/buyer names and TINs, plus the register identities
      // of every party the case joins to (approved invoice supplier/buyer,
      // client_user creator's own party).
      const names: string[] = [];
      const tins: string[] = [];
      const collect = (field: string, value: string | null | undefined): void => {
        if (!value) return;
        if (field === "supplierName" || field === "buyerName") names.push(value);
        if (field === "supplierTin" || field === "buyerTin") tins.push(value);
      };
      for (const [field, value] of Object.entries(expected)) collect(field, value);
      for (const f of kase.extraction?.fields ?? []) collect(f.field, f.value);
      const partyIds = [
        invoiceSupplierPartyId,
        invoiceBuyerPartyId,
        creatorParty,
      ].filter((id): id is string => id !== null);
      if (partyIds.length > 0) {
        const parties = await getDb()
          .select({ legalName: partiesTable.legalName, tin: partiesTable.tin })
          .from(partiesTable)
          .where(inArray(partiesTable.id, partyIds));
        for (const p of parties) {
          names.push(p.legalName);
          if (p.tin) tins.push(p.tin);
        }
      }
      // ONE scrubber across text and expected values, so both land on the
      // same pseudonyms ("Company A" in the text IS "Company A" in expected —
      // a fixture whose expectations named the real party would leak it AND
      // fail forever).
      const scrubber = createScrubber({ names, tins });
      const scrubbedText = scrubber.scrub(sourceText);
      sourceText = scrubbedText.text;
      replacements = scrubbedText.replacements;
      scrubbedExpected = Object.fromEntries(
        Object.entries(expected).map(([field, value]) => {
          if (value === null) return [field, value];
          const r = scrubber.scrub(value);
          replacements += r.replacements;
          return [field, r.text];
        }),
      );
    }

    const [row] = await getDb()
      .insert(clerkEvalFixturesTable)
      .values({
        caseId: kase.id,
        label: kase.sourceName ?? `case ${kase.id.slice(0, 8)}`,
        sourceText,
        expected: scrubbedExpected,
        // A minted fixture NEVER serves supplier memory: scrubbed content
        // must not surface as an exemplar, and an unscrubbed (untraceable)
        // mint has no register identity to key on anyway.
        supplierName: null,
        supplierTin: null,
        retiredAt: null,
      })
      .onConflictDoNothing({ target: clerkEvalFixturesTable.caseId })
      .returning();
    if (!row) {
      throw new DomainError(
        "ALREADY_FIXTURE",
        "This case is already in the eval corpus",
        409,
      );
    }

    await appendAudit({
      actorId,
      action: "clerk.eval.fixture.mint",
      entityType: "clerk_eval_fixture",
      entityId: row.id,
      // Pointer-only: never the text or the identities.
      after: {
        key: `${GROWN_KEY_PREFIX}${row.caseId.slice(0, 8)}`,
        caseId: kase.id,
        scrubbed: scrub,
        replacements,
      },
    });
    return { ...grownSummaryBase(row), ...EMPTY_HISTORY };
  });
}

// ---- Offboarding lifecycle (round 7) ---------------------------------------
// Grown fixtures ARE client document text (minted verbatim by the growth
// sweep). When a client party is offboarded (modules/party/offboard.ts), the
// fixtures traced to it — via the approved invoice's supplier party, a case
// created by one of the party's client_user members, or the obligation
// approved from a notice case (round 30) — are retired AND
// emptied: retired_at frees the corpus slot, source_text = '' (empty string,
// keeping the NOT NULL constraint while removing the content) and the
// supplier identity columns go NULL so supplier memory can never serve the
// offboarded client's document again. Expected values stay: corrections
// exclude party identity by design, so they are amounts/dates/numbers, and
// the retired row must keep past runs interpretable.
//
// Red-team fixtures have no client provenance (synthetic base + generated
// payload) and are never touched by offboarding.
//
// Party-scoped, not firm-scoped: the fixture is the CLIENT's document
// whichever firm's operator approved it. Runs in its own bypass transaction
// (the fixture tables are bypass-only RLS and the offboard request runs
// firm-scoped); like every raw-pool side write, it is durable even if the
// surrounding request later rolls back.
export async function retireFixturesForClientParty(
  partyId: string,
): Promise<number> {
  return runInBypassContext(async () => {
    const members = await getDb()
      .select({ userId: membershipsTable.userId })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.clientPartyId, partyId),
          eq(membershipsTable.role, "client_user"),
        ),
      );
    const memberIds = members.map((m) => m.userId);

    // Three trace paths, one per way a case binds to the party: the approved
    // invoice's supplier (invoice lane), a client_user creator (client-facing
    // capture), and — round 30, for grown NOTICE fixtures — the obligation
    // approved from the case, which carries the client party even when firm
    // staff did the capture (notice cases create no invoice, so the first
    // two paths never see them).
    const obligationTrace = eq(obligationsTable.clientPartyId, partyId);
    const tracedCases = getDb()
      .select({ id: clerkCasesTable.id })
      .from(clerkCasesTable)
      .leftJoin(
        invoicesTable,
        eq(invoicesTable.id, clerkCasesTable.createdInvoiceId),
      )
      .leftJoin(
        obligationsTable,
        eq(obligationsTable.sourceCaseId, clerkCasesTable.id),
      )
      .where(
        memberIds.length > 0
          ? or(
              eq(invoicesTable.supplierPartyId, partyId),
              inArray(clerkCasesTable.createdBy, memberIds),
              obligationTrace,
            )
          : or(eq(invoicesTable.supplierPartyId, partyId), obligationTrace),
      );

    const retired = await getDb()
      .update(clerkEvalFixturesTable)
      .set({
        retiredAt: new Date(),
        sourceText: "",
        supplierName: null,
        supplierTin: null,
      })
      .where(
        and(
          isNull(clerkEvalFixturesTable.retiredAt),
          inArray(clerkEvalFixturesTable.caseId, tracedCases),
        ),
      )
      .returning({ id: clerkEvalFixturesTable.id });
    return retired.length;
  });
}
