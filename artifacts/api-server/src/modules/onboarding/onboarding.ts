import { and, eq, isNull, ne, sql } from "drizzle-orm";
import {
  getDb,
  clientOnboardingRunsTable,
  engagementsTable,
  partiesTable,
  type ClientOnboardingRun,
} from "@workspace/db";
import { lagosParts } from "../../lib/lagos-time";
import { appendAudit } from "../audit/audit";
import { CONSENT_LAYERS, hasLayerConsent } from "../consent/consent";
import { DomainError } from "../errors";
import { isFeatureEnabled } from "../flags/flags";
import { scorePartyCandidates } from "../clerk/party-match";
import { mintFilingsForFirm } from "../filings/filings";
import {
  periodMonthBounds,
  previousLagosPeriod,
} from "../filings/statutory-calendar";

// Onboard with Clerk (Phase 1): the client onboarding run — an evidence-based
// checklist a firm opens when it takes on a new SME client. The one rule that
// shapes everything here: A STEP IS NEVER SELF-ATTESTED. Detection recomputes
// each step's state from SQL facts (invoices on record, statement-line
// coverage, the latest consent event, the filings register, the party
// spine), so the checklist can only claim what the data shows; the sole
// human write is a deliberate SKIP with a reason — the recorded gap the
// readiness report (Phase 3) will name honestly. Zero model calls anywhere.
//
// Concurrency: detection is idempotent recomputation (concurrent refreshes
// converge on the same facts), so it needs no claim/fence — the two jsonb
// columns are split by writer instead (detection: machine, skips: human),
// and the only contended writes are the terminal CAS transitions
// (active → completed / abandoned), each claimed by a status-guarded UPDATE
// so exactly one pass audits the transition. Creation races resolve on the
// partial unique index (one live run per firm × client), the filings
// natural-key discipline.

// The closed step catalogue, in checklist order. Growing it is a contract
// change (the enum is mirrored in the OpenAPI spec).
export const ONBOARDING_STEP_KEYS = [
  "consent_captured",
  "history_imported",
  "statements_backfilled",
  "duplicates_reviewed",
  "filings_synced",
] as const;

export type OnboardingStepKey = (typeof ONBOARDING_STEP_KEYS)[number];

// How many CLOSED Lagos months the backfill steps look at: statement
// coverage is asserted month by month over this window, and the filings
// step mints register rows for exactly these periods (per client — never
// the whole book, see mintFilingsForFirm's onlyClientPartyId).
export const ONBOARDING_BACKFILL_MONTHS = 3;

interface StepDetection {
  done: boolean;
  evidence: Record<string, unknown>;
  gaps: string[];
  checkedAt: string;
}

interface StepSkip {
  reason: string;
  byUserId: string;
  at: string;
}

export interface OnboardingStepView {
  key: OnboardingStepKey;
  status: "pending" | "done" | "skipped";
  evidence: Record<string, unknown>;
  gaps: string[];
  skippedReason: string | null;
  checkedAt: string | null;
}

export interface OnboardingRunView {
  id: string;
  clientPartyId: string;
  clientName: string;
  status: "active" | "completed" | "abandoned";
  steps: OnboardingStepView[];
  createdAt: string;
  completedAt: string | null;
}

// The last N closed Lagos periods ("YYYY-MM", newest first): shift a
// mid-month instant back k months and reuse the statutory calendar's own
// period derivation, so "closed month" has exactly one spelling. Mid-month
// (day 15) because Date.UTC day arithmetic near month boundaries would
// otherwise skip short months.
export function backfillPeriods(
  now: Date = new Date(),
  count: number = ONBOARDING_BACKFILL_MONTHS,
): string[] {
  const { year, monthIndex } = lagosParts(now);
  return Array.from({ length: count }, (_, k) =>
    previousLagosPeriod(new Date(Date.UTC(year, monthIndex - k, 15))),
  );
}

const LIVE_ENGAGEMENT = sql`${engagementsTable.status} IN ('open', 'in_progress')`;

async function hasLiveEngagement(
  firmId: string,
  clientPartyId: string,
): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: engagementsTable.id })
    .from(engagementsTable)
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        eq(engagementsTable.clientPartyId, clientPartyId),
        LIVE_ENGAGEMENT,
      ),
    )
    .limit(1);
  return Boolean(row);
}

// --- per-step detection (each pure SQL, each returning the full record) ---

async function detectConsent(clientPartyId: string): Promise<StepDetection> {
  const granted = await hasLayerConsent(
    clientPartyId,
    CONSENT_LAYERS.COMPLIANCE,
  );
  return {
    done: granted,
    evidence: { layer: CONSENT_LAYERS.COMPLIANCE },
    gaps: granted
      ? []
      : [
          "Layer-1 compliance consent has not been granted — submission, reconciliation and alerts stay dark until the client consents",
        ],
    checkedAt: new Date().toISOString(),
  };
}

async function detectHistory(
  firmId: string,
  clientPartyId: string,
): Promise<StepDetection> {
  const [row] = (
    await getDb().execute<{
      n: number;
      earliest: string | null;
      latest: string | null;
    }>(sql`
      SELECT COUNT(*)::int AS n,
             MIN(i.issue_date)::text AS earliest,
             MAX(i.issue_date)::text AS latest
      FROM invoices i
      WHERE i.firm_id = ${firmId}
        AND i.supplier_party_id = ${clientPartyId}
    `)
  ).rows;
  const count = Number(row?.n ?? 0);
  return {
    done: count > 0,
    evidence: {
      invoiceCount: count,
      earliestIssueDate: row?.earliest ?? null,
      latestIssueDate: row?.latest ?? null,
    },
    gaps:
      count > 0
        ? []
        : [
            "No invoices on record yet — import the client's history (CSV or scanned bundle), or skip if they are genuinely starting fresh",
          ],
    checkedAt: new Date().toISOString(),
  };
}

async function detectStatements(
  firmId: string,
  clientPartyId: string,
  now: Date,
): Promise<StepDetection> {
  const reconciliationLit = await isFeatureEnabled("reconciliation", firmId);
  if (!reconciliationLit) {
    return {
      done: false,
      evidence: { monthsCovered: [], monthsMissing: backfillPeriods(now) },
      gaps: [
        "The reconciliation rail is dark for this firm — enable the flag to backfill statements, or skip this step",
      ],
      checkedAt: new Date().toISOString(),
    };
  }
  const periods = backfillPeriods(now);
  const oldest = periodMonthBounds(periods[periods.length - 1]).start;
  const newest = periodMonthBounds(periods[0]).end;
  // A month counts as covered when a committed/reconciled statement of this
  // client carries at least one parsed line value-dated inside it — the
  // statement itself has no period column, so coverage is a fact about
  // lines, not uploads.
  const covered = new Set(
    (
      await getDb().execute<{ period: string }>(sql`
        SELECT DISTINCT to_char(l.value_date, 'YYYY-MM') AS period
        FROM bank_statement_lines l
        JOIN bank_statements s ON s.id = l.statement_id
        WHERE s.firm_id = ${firmId}
          AND s.client_party_id = ${clientPartyId}
          AND s.status IN ('committed', 'reconciled')
          AND l.value_date IS NOT NULL
          AND l.value_date >= ${oldest}::date
          AND l.value_date < ${newest}::date
      `)
    ).rows.map((r) => r.period),
  );
  const missing = periods.filter((p) => !covered.has(p));
  return {
    done: missing.length === 0,
    evidence: {
      monthsCovered: periods.filter((p) => covered.has(p)),
      monthsMissing: missing,
    },
    gaps: missing.map((p) => `No bank statement covers ${p}`),
    checkedAt: new Date().toISOString(),
  };
}

// Duplicate-client scan: the onboarded party's identity (name + TIN) scored
// against the firm's OTHER engaged clients with the capture-time scorer
// (party-match.ts — TIN exact-after-normalize at 0.6, name-token containment
// at 0.4). Advisory only: party.merge is operator-only, so the step's "done"
// is simply a clean scan; a surfaced candidate keeps the step pending until
// an operator merges or the firm skips after review.
async function detectDuplicates(
  firmId: string,
  clientPartyId: string,
): Promise<StepDetection> {
  const [self] = await getDb()
    .select({
      legalName: partiesTable.legalName,
      tin: partiesTable.tin,
    })
    .from(partiesTable)
    .where(eq(partiesTable.id, clientPartyId))
    .limit(1);
  if (!self) {
    throw new DomainError("NOT_FOUND", "Client not found", 404);
  }
  const candidates = await getDb()
    .selectDistinct({
      id: partiesTable.id,
      legalName: partiesTable.legalName,
      tin: partiesTable.tin,
      type: partiesTable.type,
    })
    .from(engagementsTable)
    .innerJoin(
      partiesTable,
      eq(partiesTable.id, engagementsTable.clientPartyId),
    )
    .where(
      and(
        eq(engagementsTable.firmId, firmId),
        ne(engagementsTable.clientPartyId, clientPartyId),
        isNull(partiesTable.mergedIntoId),
      ),
    );
  const suggestions = scorePartyCandidates(
    { name: self.legalName, tin: self.tin },
    candidates,
  );
  return {
    done: suggestions.length === 0,
    evidence: {
      suggestions: suggestions.map((s) => ({
        partyId: s.partyId,
        legalName: s.legalName,
        confidence: s.confidence,
      })),
    },
    gaps: suggestions.map(
      (s) =>
        `Possible duplicate of ${s.legalName} (confidence ${s.confidence}) — an operator can merge, or skip after review`,
    ),
    checkedAt: new Date().toISOString(),
  };
}

// The one machine-EXECUTING step: mint this client's register rows for the
// backfill window (per-period, per-client — the natural unique key absorbs
// re-runs), then read coverage back from the register itself so the
// detection reports what exists, not what the mint claimed.
async function detectFilings(
  firmId: string,
  clientPartyId: string,
  now: Date,
): Promise<StepDetection> {
  const periods = backfillPeriods(now);
  const { year, monthIndex } = lagosParts(now);
  let minted = 0;
  for (let k = 0; k < periods.length; k++) {
    minted += await mintFilingsForFirm(
      firmId,
      new Date(Date.UTC(year, monthIndex - k, 15)),
      clientPartyId,
    );
  }
  const present = new Set(
    (
      await getDb().execute<{ period: string }>(sql`
        SELECT DISTINCT period
        FROM filing_returns
        WHERE firm_id = ${firmId}
          AND client_party_id = ${clientPartyId}
          AND period IN (${sql.join(
            periods.map((p) => sql`${p}`),
            sql`, `,
          )})
      `)
    ).rows.map((r) => r.period),
  );
  const missing = periods.filter((p) => !present.has(p));
  return {
    done: missing.length === 0,
    evidence: { periods, mintedThisPass: minted },
    gaps: missing.map(
      (p) =>
        `No filing register rows for ${p} — is the client's engagement live?`,
    ),
    checkedAt: new Date().toISOString(),
  };
}

async function detectAll(
  firmId: string,
  clientPartyId: string,
  now: Date,
): Promise<Record<OnboardingStepKey, StepDetection>> {
  // Sequential on purpose: detection runs on ONE connection (the request
  // transaction or the sweep's bypass scope), where parallel awaits only
  // queue on the client — and pg deprecates overlapped query() calls.
  return {
    consent_captured: await detectConsent(clientPartyId),
    history_imported: await detectHistory(firmId, clientPartyId),
    statements_backfilled: await detectStatements(firmId, clientPartyId, now),
    duplicates_reviewed: await detectDuplicates(firmId, clientPartyId),
    filings_synced: await detectFilings(firmId, clientPartyId, now),
  };
}

// --- run lifecycle ---

export async function createOnboardingRun(
  firmId: string,
  clientPartyId: string,
  createdBy: string,
): Promise<ClientOnboardingRun> {
  if (!(await hasLiveEngagement(firmId, clientPartyId))) {
    throw new DomainError(
      "NO_LIVE_ENGAGEMENT",
      "The firm has no live engagement with this client",
      409,
    );
  }
  // The partial unique index (one live run per firm × client) is the
  // cross-instance gate; a concurrent create loses as a conflict no-op and
  // reads the winner back.
  const [inserted] = await getDb()
    .insert(clientOnboardingRunsTable)
    .values({ firmId, clientPartyId, createdBy })
    .onConflictDoNothing()
    .returning();
  if (!inserted) {
    throw new DomainError(
      "RUN_EXISTS",
      "An onboarding run is already active for this client",
      409,
    );
  }
  await appendAudit({
    actorId: createdBy,
    firmId,
    action: "onboarding.run_created",
    entityType: "onboarding_run",
    entityId: inserted.id,
    after: { clientPartyId },
  });
  // First detection inline so the creator sees a populated checklist, not
  // five pending rows waiting for the sweep.
  return refreshOnboardingRun(inserted.id, firmId);
}

// Recompute every step from facts, then settle the run's terminal state:
// engagement gone → abandoned; every step done-or-skipped → completed. Both
// transitions are status-guarded CAS updates, so of any number of concurrent
// passes exactly one audits. Detection itself is written unconditionally —
// it is derived state, and the last writer's facts are as good as the
// first's.
export async function refreshOnboardingRun(
  runId: string,
  firmId: string,
): Promise<ClientOnboardingRun> {
  const [run] = await getDb()
    .select()
    .from(clientOnboardingRunsTable)
    .where(
      and(
        eq(clientOnboardingRunsTable.id, runId),
        eq(clientOnboardingRunsTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!run) {
    throw new DomainError("NOT_FOUND", "Onboarding run not found", 404);
  }
  if (run.status !== "active") return run;

  if (!(await hasLiveEngagement(firmId, run.clientPartyId))) {
    const [abandoned] = await getDb()
      .update(clientOnboardingRunsTable)
      .set({ status: "abandoned", updatedAt: new Date() })
      .where(
        and(
          eq(clientOnboardingRunsTable.id, runId),
          eq(clientOnboardingRunsTable.status, "active"),
        ),
      )
      .returning();
    if (abandoned) {
      await appendAudit({
        firmId,
        action: "onboarding.run_abandoned",
        entityType: "onboarding_run",
        entityId: runId,
        after: { reason: "engagement_closed" },
      });
      return abandoned;
    }
    return refreshOnboardingRun(runId, firmId);
  }

  const now = new Date();
  const detection = await detectAll(firmId, run.clientPartyId, now);
  const [updated] = await getDb()
    .update(clientOnboardingRunsTable)
    .set({ detection, updatedAt: now })
    .where(eq(clientOnboardingRunsTable.id, runId))
    .returning();
  if (!updated) {
    throw new DomainError("NOT_FOUND", "Onboarding run not found", 404);
  }

  const skips = (updated.skips ?? {}) as Record<string, StepSkip>;
  const allSettled = ONBOARDING_STEP_KEYS.every(
    (key) => detection[key].done || skips[key],
  );
  if (!allSettled || updated.status !== "active") return updated;
  const [completed] = await getDb()
    .update(clientOnboardingRunsTable)
    .set({ status: "completed", completedAt: now, updatedAt: now })
    .where(
      and(
        eq(clientOnboardingRunsTable.id, runId),
        eq(clientOnboardingRunsTable.status, "active"),
        isNull(clientOnboardingRunsTable.completedAt),
      ),
    )
    .returning();
  if (completed) {
    await appendAudit({
      firmId,
      action: "onboarding.run_completed",
      entityType: "onboarding_run",
      entityId: runId,
      after: {
        doneSteps: ONBOARDING_STEP_KEYS.filter((k) => detection[k].done)
          .length,
        skippedSteps: ONBOARDING_STEP_KEYS.filter(
          (k) => !detection[k].done && skips[k],
        ).length,
      },
    });
    return completed;
  }
  return updated;
}

// The firm records a deliberate gap. Refusals are the point: a step the
// facts already satisfy cannot be skipped (the skip would be a lie the
// readiness report repeats), and a terminal run is read-only.
export async function skipOnboardingStep(
  runId: string,
  firmId: string,
  stepKey: OnboardingStepKey,
  reason: string,
  byUserId: string,
): Promise<ClientOnboardingRun> {
  const [run] = await getDb()
    .select()
    .from(clientOnboardingRunsTable)
    .where(
      and(
        eq(clientOnboardingRunsTable.id, runId),
        eq(clientOnboardingRunsTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!run) {
    throw new DomainError("NOT_FOUND", "Onboarding run not found", 404);
  }
  if (run.status !== "active") {
    throw new DomainError(
      "RUN_NOT_ACTIVE",
      "This onboarding run is no longer active",
      409,
    );
  }
  const detection = (run.detection ?? {}) as Record<string, StepDetection>;
  if (detection[stepKey]?.done) {
    throw new DomainError(
      "STEP_ALREADY_DONE",
      "This step is already satisfied by the record — nothing to skip",
      409,
    );
  }
  const skip: StepSkip = {
    reason,
    byUserId,
    at: new Date().toISOString(),
  };
  // Targeted jsonb_set on the human-only column: never read-modify-write the
  // whole object, so two staff skipping different steps cannot clobber each
  // other.
  await getDb().execute(sql`
    UPDATE client_onboarding_runs
    SET skips = jsonb_set(skips, ${sql.raw(`'{${stepKey}}'`)}, ${JSON.stringify(skip)}::jsonb),
        updated_at = now()
    WHERE id = ${runId} AND firm_id = ${firmId} AND status = 'active'
  `);
  await appendAudit({
    actorId: byUserId,
    firmId,
    action: "onboarding.step_skipped",
    entityType: "onboarding_run",
    entityId: runId,
    // Pointer-only (SEC-12): the step key is catalogue vocabulary; the free-
    // text reason stays on the row, never in the audit payload.
    after: { stepKey },
  });
  // A skip can be the last settling move — let refresh run the completion CAS.
  return refreshOnboardingRun(runId, firmId);
}

export async function abandonOnboardingRun(
  runId: string,
  firmId: string,
  byUserId: string,
): Promise<ClientOnboardingRun> {
  const [abandoned] = await getDb()
    .update(clientOnboardingRunsTable)
    .set({ status: "abandoned", updatedAt: new Date() })
    .where(
      and(
        eq(clientOnboardingRunsTable.id, runId),
        eq(clientOnboardingRunsTable.firmId, firmId),
        eq(clientOnboardingRunsTable.status, "active"),
      ),
    )
    .returning();
  if (!abandoned) {
    // Distinguish absent from terminal without a second lookup cost when
    // active — one read only on the refusal path.
    const [run] = await getDb()
      .select({ status: clientOnboardingRunsTable.status })
      .from(clientOnboardingRunsTable)
      .where(
        and(
          eq(clientOnboardingRunsTable.id, runId),
          eq(clientOnboardingRunsTable.firmId, firmId),
        ),
      )
      .limit(1);
    if (!run) {
      throw new DomainError("NOT_FOUND", "Onboarding run not found", 404);
    }
    throw new DomainError(
      "RUN_NOT_ACTIVE",
      "This onboarding run is no longer active",
      409,
    );
  }
  await appendAudit({
    actorId: byUserId,
    firmId,
    action: "onboarding.run_abandoned",
    entityType: "onboarding_run",
    entityId: runId,
    after: { reason: "manual" },
  });
  return abandoned;
}

// --- reads ---

export async function listOnboardingRuns(
  firmId: string,
  clientPartyId?: string,
): Promise<ClientOnboardingRun[]> {
  return getDb()
    .select()
    .from(clientOnboardingRunsTable)
    .where(
      and(
        eq(clientOnboardingRunsTable.firmId, firmId),
        ...(clientPartyId
          ? [eq(clientOnboardingRunsTable.clientPartyId, clientPartyId)]
          : []),
      ),
    )
    .orderBy(
      sql`${clientOnboardingRunsTable.status} = 'active' DESC`,
      sql`${clientOnboardingRunsTable.createdAt} DESC`,
    );
}

export async function getOnboardingRun(
  runId: string,
  firmId: string,
): Promise<ClientOnboardingRun> {
  const [run] = await getDb()
    .select()
    .from(clientOnboardingRunsTable)
    .where(
      and(
        eq(clientOnboardingRunsTable.id, runId),
        eq(clientOnboardingRunsTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!run) {
    throw new DomainError("NOT_FOUND", "Onboarding run not found", 404);
  }
  return run;
}

// Serialize a run for the contract: catalogue order, skip overlaying
// detection (a skipped step stays skipped even when its facts later turn
// done — the human decision is the record; refresh's completion check
// treats done-or-skipped identically).
export async function onboardingRunView(
  run: ClientOnboardingRun,
): Promise<OnboardingRunView> {
  const [client] = await getDb()
    .select({ legalName: partiesTable.legalName })
    .from(partiesTable)
    .where(eq(partiesTable.id, run.clientPartyId))
    .limit(1);
  const detection = (run.detection ?? {}) as Record<string, StepDetection>;
  const skips = (run.skips ?? {}) as Record<string, StepSkip>;
  return {
    id: run.id,
    clientPartyId: run.clientPartyId,
    clientName: client?.legalName ?? "",
    status: run.status,
    steps: ONBOARDING_STEP_KEYS.map((key) => {
      const d = detection[key];
      const s = skips[key];
      return {
        key,
        status: d?.done ? "done" : s ? "skipped" : "pending",
        evidence: d?.evidence ?? {},
        gaps: d?.gaps ?? [],
        skippedReason: s?.reason ?? null,
        checkedAt: d?.checkedAt ?? null,
      };
    }),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}
