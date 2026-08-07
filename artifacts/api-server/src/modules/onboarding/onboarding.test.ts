import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  bankStatementsTable,
  bankStatementLinesTable,
  clientOnboardingRunsTable,
  engagementsTable,
  featureFlagsTable,
  featureFlagOverridesTable,
  firmsTable,
  invoicesTable,
  partiesTable,
  usersTable,
} from "@workspace/db";
import { isDomainError } from "../../test-helpers/assertions.ts";
import { lagosDateString } from "../../lib/lagos-time.ts";
import { makeRunSalt } from "../../test-helpers/fixtures.ts";
import { grantComplianceConsent } from "../../test-helpers/seeders.ts";
import {
  ONBOARDING_STEP_KEYS,
  ONBOARDING_BACKFILL_MONTHS,
  backfillPeriods,
  createOnboardingRun,
  refreshOnboardingRun,
  skipOnboardingStep,
  abandonOnboardingRun,
  listOnboardingRuns,
  onboardingRunView,
} from "./onboarding.ts";
import { sweepOnboardingRuns } from "./sweep.ts";
import { computeOpeningPosition } from "./opening-position.ts";
import { periodMonthBounds } from "../filings/statutory-calendar.ts";

// Onboard with Clerk Phase 1: the evidence-based checklist. What matters
// here: steps settle from FACTS (never attestation) — consent events,
// invoice counts, statement-line month coverage, the duplicate scan, the
// filings backfill; skips survive refreshes (writer-split jsonb columns);
// the terminal transitions are CAS-once (exactly one completion audit);
// the filings backfill mints for THIS client only; and re-onboarding is
// possible after abandon but never concurrently. Fixtures are salted and
// every assertion scopes to this run's own firm ids — the shared DB
// persists across suites (and the sweep refreshes every active run in it).

const SALT = makeRunSalt();

const firmId = randomUUID();
const otherFirmId = randomUUID();
const clientA = randomUUID(); // the full-journey client
const clientFresh = randomUUID(); // newly incorporated — skips carry it
const clientDupe = randomUUID(); // near-duplicate of clientA by TIN
const clientNoEng = randomUUID(); // engaged by nobody
const otherClient = randomUUID(); // the other firm's book must not leak in
const userId = randomUUID();

before(async () => {
  const db = getDb();
  await db
    .insert(usersTable)
    .values({ id: userId, email: `onboarding-${SALT}@test.local` })
    .onConflictDoNothing();
  await db.insert(firmsTable).values([
    { id: firmId, name: `Onboarding Firm ${SALT}` },
    { id: otherFirmId, name: `Onboarding Firm B ${SALT}` },
  ]);
  await db.insert(partiesTable).values([
    {
      id: clientA,
      type: "client_business" as const,
      legalName: `Adeyemi Traders ${SALT}`,
      tin: `1234${SALT.slice(0, 4)}01`,
    },
    {
      id: clientFresh,
      type: "client_business" as const,
      legalName: `Fresh Start Ventures ${SALT}`,
    },
    {
      id: clientDupe,
      type: "client_business" as const,
      legalName: `Adeyemi Traders Nigeria ${SALT}`,
      tin: `1234${SALT.slice(0, 4)}01`,
    },
    {
      id: clientNoEng,
      type: "client_business" as const,
      legalName: `Unengaged ${SALT}`,
    },
    {
      id: otherClient,
      type: "client_business" as const,
      legalName: `Foreign Book ${SALT}`,
    },
  ]);
  await db.insert(engagementsTable).values(
    [
      { firm: firmId, client: clientA },
      { firm: firmId, client: clientFresh },
      { firm: firmId, client: clientDupe },
      { firm: otherFirmId, client: otherClient },
    ].map(({ firm, client }, i) => ({
      firmId: firm,
      clientPartyId: client,
      type: "retainer" as const,
      status: "open" as const,
      title: `onboarding ${i} ${SALT}`,
    })),
  );
  // Statements detection is dark-gated on the reconciliation flag; enable it
  // for the fixture firm only (the debit-lane suite's spelling).
  await db
    .insert(featureFlagsTable)
    .values({ key: "reconciliation", enabled: false, releaseTag: "R2" })
    .onConflictDoNothing({ target: featureFlagsTable.key });
  await db
    .insert(featureFlagOverridesTable)
    .values({ flagKey: "reconciliation", firmId, enabled: true })
    .onConflictDoNothing();
});

test("backfillPeriods: the last N closed Lagos periods, newest first", () => {
  const periods = backfillPeriods(new Date("2026-08-06T12:00:00Z"));
  assert.deepEqual(periods, ["2026-07", "2026-06", "2026-05"]);
  assert.equal(periods.length, ONBOARDING_BACKFILL_MONTHS);
  // January walks into the previous year without skipping a month.
  assert.deepEqual(backfillPeriods(new Date("2026-01-10T12:00:00Z")), [
    "2025-12",
    "2025-11",
    "2025-10",
  ]);
});

test("creation requires a live engagement and dedupes on the live-run gate", async () => {
  await assert.rejects(
    createOnboardingRun(firmId, clientNoEng, userId),
    isDomainError("NO_LIVE_ENGAGEMENT"),
  );
  const run = await createOnboardingRun(firmId, clientA, userId);
  assert.equal(run.status, "active");
  // The first detection pass ran inline: every step carries a record.
  const view = await onboardingRunView(run);
  assert.equal(view.steps.length, ONBOARDING_STEP_KEYS.length);
  for (const step of view.steps) {
    assert.ok(step.checkedAt, `${step.key} was detected at creation`);
  }
  await assert.rejects(
    createOnboardingRun(firmId, clientA, userId),
    isDomainError("RUN_EXISTS", 409),
  );
});

test("the journey: facts settle steps one by one; completion claims once", async () => {
  const db = getDb();
  const [run] = await db
    .select()
    .from(clientOnboardingRunsTable)
    .where(
      and(
        eq(clientOnboardingRunsTable.firmId, firmId),
        eq(clientOnboardingRunsTable.clientPartyId, clientA),
      ),
    );
  assert.ok(run);

  // At creation: filings backfill has already executed (machine step), the
  // duplicate scan flags clientDupe (same TIN), everything else is pending.
  let view = await onboardingRunView(await refreshOnboardingRun(run.id, firmId));
  const byKey = () => new Map(view.steps.map((s) => [s.key, s]));
  let steps = byKey();
  assert.equal(steps.get("filings_synced")?.status, "done");
  assert.equal(steps.get("consent_captured")?.status, "pending");
  assert.equal(steps.get("history_imported")?.status, "pending");
  assert.equal(steps.get("statements_backfilled")?.status, "pending");
  assert.equal(steps.get("duplicates_reviewed")?.status, "pending");
  const dupeEvidence = steps.get("duplicates_reviewed")?.evidence as {
    suggestions: { partyId: string }[];
  };
  assert.ok(
    dupeEvidence.suggestions.some((s) => s.partyId === clientDupe),
    "the TIN twin is surfaced as a duplicate candidate",
  );

  // The filings backfill minted ONLY this client's register rows — the firm's
  // other clients (clientFresh, clientDupe) got nothing backdated.
  const foreignRows = (
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM filing_returns
      WHERE firm_id = ${firmId} AND client_party_id <> ${clientA}
    `)
  ).rows;
  assert.equal(Number(foreignRows[0]?.n), 0, "per-client mint stayed pinned");
  const ownRows = (
    await db.execute<{ n: number }>(sql`
      SELECT COUNT(DISTINCT period)::int AS n FROM filing_returns
      WHERE firm_id = ${firmId} AND client_party_id = ${clientA}
    `)
  ).rows;
  assert.equal(
    Number(ownRows[0]?.n),
    ONBOARDING_BACKFILL_MONTHS,
    "all backfill periods minted",
  );

  // The no-day-one-blast rule: every backfilled row BORN overdue (statutory
  // date already past at mint) claimed both reminder slots silently, so the
  // reminder sweep has nothing to send for pre-engagement periods; a row
  // whose date is still ahead claimed nothing and keeps its lifecycle.
  const ledger = (
    await db.execute<{ due_date: string; slots: number }>(sql`
      SELECT f.due_date::text AS due_date, COUNT(s.id)::int AS slots
      FROM filing_returns f
      LEFT JOIN filing_reminder_sends s ON s.filing_id = f.id
      WHERE f.firm_id = ${firmId} AND f.client_party_id = ${clientA}
      GROUP BY f.id, f.due_date
    `)
  ).rows;
  const today = lagosDateString(new Date());
  assert.ok(
    ledger.some((r) => r.due_date < today),
    "the backfill window always reaches at least one born-overdue row",
  );
  for (const r of ledger) {
    assert.equal(
      Number(r.slots),
      r.due_date < today ? 2 : 0,
      `row due ${r.due_date}: silent claim exactly when born overdue`,
    );
  }

  // Facts land: consent, history, statement coverage for all three months.
  await grantComplianceConsent(clientA, userId);
  await db.insert(invoicesTable).values({
    firmId,
    supplierPartyId: clientA,
    buyerPartyId: clientDupe,
    invoiceNumber: `ONB-HIST-${SALT}`,
    status: "draft",
    issueDate: "2026-05-20",
    subtotal: "100000.00",
    vatTotal: "7500.00",
    grandTotal: "107500.00",
  });
  const stmtId = randomUUID();
  await db.insert(bankStatementsTable).values({
    id: stmtId,
    firmId,
    clientPartyId: clientA,
    formatKey: "generic_csv",
    status: "committed",
  });
  const periods = backfillPeriods(new Date());
  await db.insert(bankStatementLinesTable).values(
    periods.map((p, i) => ({
      statementId: stmtId,
      lineNo: i + 1,
      valueDate: periodMonthBounds(p).start,
      amount: "1000.00",
      parseStatus: "parsed" as const,
      rawLine: `line ${p}`,
    })),
  );

  view = await onboardingRunView(await refreshOnboardingRun(run.id, firmId));
  steps = byKey();
  assert.equal(steps.get("consent_captured")?.status, "done");
  assert.equal(steps.get("history_imported")?.status, "done");
  assert.equal(steps.get("statements_backfilled")?.status, "done");
  assert.equal(steps.get("duplicates_reviewed")?.status, "pending");
  assert.equal(view.status, "active", "one pending step holds the run open");

  // The firm reviews the duplicate and records the gap — the settling move,
  // so the same call walks the run to completed via the CAS.
  const settled = await skipOnboardingStep(
    run.id,
    firmId,
    "duplicates_reviewed",
    "Reviewed — distinct businesses despite the shared TIN",
    userId,
  );
  assert.equal(settled.status, "completed");
  assert.ok(settled.completedAt);

  // Phase 2: the completion CAS froze the day-one opening position in the
  // same UPDATE that terminalized the run.
  const frozen = settled.openingPosition as {
    provisional: boolean;
    history: { invoiceCount: number };
  } | null;
  assert.ok(frozen, "a completed run carries its frozen baseline");
  assert.equal(frozen.provisional, false);
  assert.equal(frozen.history.invoiceCount, 1);

  // The baseline is permanent: later facts move the LIVE picture, never
  // the frozen one.
  await db.insert(invoicesTable).values({
    firmId,
    supplierPartyId: clientA,
    buyerPartyId: clientDupe,
    invoiceNumber: `ONB-LATER-${SALT}`,
    status: "draft",
    issueDate: "2026-08-01",
    subtotal: "50000.00",
    vatTotal: "3750.00",
    grandTotal: "53750.00",
  });
  await refreshOnboardingRun(run.id, firmId);
  const [afterRefresh] = await db
    .select()
    .from(clientOnboardingRunsTable)
    .where(eq(clientOnboardingRunsTable.id, run.id));
  assert.equal(
    (afterRefresh.openingPosition as { history: { invoiceCount: number } })
      .history.invoiceCount,
    1,
    "the frozen baseline never rewrites",
  );
  const live = await computeOpeningPosition(firmId, clientA, {
    provisional: true,
  });
  assert.equal(live.provisional, true);
  assert.equal(live.history.invoiceCount, 2, "the live picture moves");

  // Contract lockstep: both lives of the position must parse under the
  // generated response schema — the module shape and the spec's $ref
  // composition (ClientVatPosition, ReceivablesSummary, …) drift apart
  // silently otherwise, and the route would 500 on the first real read.
  const { GetOnboardingOpeningPositionResponse } = await import(
    "@workspace/api-zod"
  );
  GetOnboardingOpeningPositionResponse.parse(frozen);
  GetOnboardingOpeningPositionResponse.parse(live);

  // Phase 3: the readiness report renders from the frozen record (zero
  // model calls — a real PDF buffer with no gateway in sight), and the Ask
  // intent answers from the same rows the checklist maintains.
  const { renderOnboardingReportPdf } = await import("./report-pdf.ts");
  const pdf = await renderOnboardingReportPdf({
    run: view,
    position: frozen as unknown as Parameters<
      typeof renderOnboardingReportPdf
    >[0]["position"],
    firmName: `Onboarding Firm ${SALT}`,
    theme: null,
  });
  assert.ok(pdf.length > 1000, "a substantive PDF rendered");
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");

  const { runDataIntent } = await import("../clerk/data-intents/index.ts");
  const pinned = await runDataIntent("data.onboarding_status", firmId, {
    clientPartyId: clientA,
    clientName: `Adaeyemi`,
  });
  assert.ok(pinned);
  assert.ok(
    pinned.text.includes("completed"),
    "the pinned answer speaks the run's status",
  );
  assert.ok(pinned.facts.some((f) => f.key === "onboarding_settled"));
  const firmWide = await runDataIntent("data.onboarding_status", firmId);
  assert.ok(firmWide);
  assert.ok(firmWide.facts.some((f) => f.key === "onboarding_active"));
  view = await onboardingRunView(settled);
  assert.equal(view.steps.find((s) => s.key === "duplicates_reviewed")?.status, "skipped");

  // Exactly ONE completion audit despite refresh converging again.
  await refreshOnboardingRun(run.id, firmId);
  const audits = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "onboarding.run_completed"),
        eq(auditEventsTable.entityId, run.id),
      ),
    );
  assert.equal(audits.length, 1, "completion audited exactly once");

  // Terminal runs refuse further writes.
  await assert.rejects(
    skipOnboardingStep(run.id, firmId, "consent_captured", "too late", userId),
    isDomainError("RUN_NOT_ACTIVE", 409),
  );
  await assert.rejects(
    abandonOnboardingRun(run.id, firmId, userId),
    isDomainError("RUN_NOT_ACTIVE", 409),
  );
});

test("skips survive refresh and cannot overwrite a fact-satisfied step", async () => {
  const run = await createOnboardingRun(firmId, clientFresh, userId);
  // filings_synced settles at creation — the record already satisfies it.
  await assert.rejects(
    skipOnboardingStep(run.id, firmId, "filings_synced", "not needed", userId),
    isDomainError("STEP_ALREADY_DONE", 409),
  );
  const skipped = await skipOnboardingStep(
    run.id,
    firmId,
    "history_imported",
    "Newly incorporated — no history exists",
    userId,
  );
  let view = await onboardingRunView(skipped);
  assert.equal(
    view.steps.find((s) => s.key === "history_imported")?.status,
    "skipped",
  );
  // The machine's detection pass must not eat the human's record.
  view = await onboardingRunView(await refreshOnboardingRun(run.id, firmId));
  const step = view.steps.find((s) => s.key === "history_imported");
  assert.equal(step?.status, "skipped");
  assert.equal(step?.skippedReason, "Newly incorporated — no history exists");
  // The skip is pointer-only in the ledger: the reason stays on the row.
  const db = getDb();
  const [audit] = await db
    .select()
    .from(auditEventsTable)
    .where(
      and(
        eq(auditEventsTable.action, "onboarding.step_skipped"),
        eq(auditEventsTable.entityId, run.id),
      ),
    );
  assert.ok(audit);
  assert.deepEqual(audit.after, { stepKey: "history_imported" });
  // Clean up: abandon so the sweep test below sees a known active set.
  await abandonOnboardingRun(run.id, firmId, userId);
});

test("abandon frees the live-run gate; the sweep refreshes and auto-abandons", async () => {
  const db = getDb();
  const run = await createOnboardingRun(firmId, clientDupe, userId);
  // A second live run is refused while this one is active (gate held)...
  await assert.rejects(
    createOnboardingRun(firmId, clientDupe, userId),
    isDomainError("RUN_EXISTS", 409),
  );
  // ...the engagement closing flips the run to abandoned on the next sweep
  // pass (the run must not outlive the book it was onboarding into).
  await db
    .update(engagementsTable)
    .set({ status: "archived" })
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientDupe),
      ),
    );
  await sweepOnboardingRuns();
  const [after] = await db
    .select()
    .from(clientOnboardingRunsTable)
    .where(eq(clientOnboardingRunsTable.id, run.id));
  assert.equal(after.status, "abandoned");
  // The freed gate admits a fresh run once the engagement is live again.
  await db
    .update(engagementsTable)
    .set({ status: "open" })
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientDupe),
      ),
    );
  const again = await createOnboardingRun(firmId, clientDupe, userId);
  assert.equal(again.status, "active");
  await abandonOnboardingRun(again.id, firmId, userId);
});

test("firm scoping: lists stay inside the firm; foreign ids 404 without disclosure", async () => {
  const runs = await listOnboardingRuns(firmId);
  assert.ok(runs.length >= 1);
  assert.ok(runs.every((r) => r.firmId === firmId));
  const [anyRun] = runs;
  await assert.rejects(
    refreshOnboardingRun(anyRun.id, otherFirmId),
    isDomainError("NOT_FOUND", 404),
  );
  await assert.rejects(
    skipOnboardingStep(anyRun.id, otherFirmId, "consent_captured", "nope", userId),
    isDomainError("NOT_FOUND", 404),
  );
  await assert.rejects(
    abandonOnboardingRun(anyRun.id, otherFirmId, userId),
    isDomainError("NOT_FOUND", 404),
  );
  const filtered = await listOnboardingRuns(firmId, clientA);
  assert.ok(filtered.every((r) => r.clientPartyId === clientA));
});
