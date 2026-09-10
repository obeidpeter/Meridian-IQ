import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import {
  creditBankAccessEventsTable,
  creditDataRoomAccessEventsTable,
  getDb,
  usersTable,
} from "@workspace/db";
import { canonicalJson } from "../../lib/canonical-json";
import { lagosTodaySql } from "../../lib/lagos-time";
import { appendAudit } from "../audit/audit";
import type { Principal } from "../auth/rbac";
import { DomainError } from "../errors";
import { isUuid } from "../../lib/uuid";

const DEFAULT_MIN_COHORT = 5;
const MAX_MIN_COHORT = 100;

function minimumCohortSize(): number {
  const configured = Number(process.env.CREDIT_COHORT_MIN_SIZE);
  if (!Number.isInteger(configured)) return DEFAULT_MIN_COHORT;
  return Math.min(MAX_MIN_COHORT, Math.max(DEFAULT_MIN_COHORT, configured));
}

const pct = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

const number = (value: unknown): number => Number(value ?? 0);
const nullableIso = (value: unknown): string | null =>
  value === null || value === undefined
    ? null
    : new Date(value as string | number | Date).toISOString();

interface BankAccessContext {
  bankPartyId: string;
  userId: string;
  dpaReference: string;
  validUntil: Date | null;
}

// The bank principal runs with database bypass, so this application predicate
// is a hard security boundary and is deliberately repeated on every route.
async function assertBankDataRoomAccess(
  principal: Principal,
): Promise<BankAccessContext> {
  if (principal.role !== "bank_user" || !isUuid(principal.userId)) {
    throw new DomainError(
      "BANK_ACCESS_REQUIRED",
      "A bank Data Room identity is required",
      403,
    );
  }
  const [[user], [access]] = await Promise.all([
    getDb()
      .select({ totpEnabledAt: usersTable.totpEnabledAt })
      .from(usersTable)
      .where(eq(usersTable.id, principal.userId))
      .limit(1),
    getDb()
      .select()
      .from(creditBankAccessEventsTable)
      .where(eq(creditBankAccessEventsTable.userId, principal.userId))
      .orderBy(
        desc(creditBankAccessEventsTable.createdAt),
        desc(creditBankAccessEventsTable.id),
      )
      .limit(1),
  ]);
  if (!user?.totpEnabledAt) {
    throw new DomainError(
      "MFA_REQUIRED",
      "Two-factor authentication is required for the bank Data Room",
      403,
    );
  }
  const now = Date.now();
  if (
    !access ||
    access.action !== "grant" ||
    !access.dpaReference ||
    !access.dpaExecutedAt ||
    access.dpaExecutedAt.getTime() > now ||
    (access.validUntil !== null && access.validUntil.getTime() <= now)
  ) {
    throw new DomainError(
      "BANK_ACCESS_INACTIVE",
      "Bank Data Room access is not active",
      403,
    );
  }
  return {
    bankPartyId: access.bankPartyId,
    userId: principal.userId,
    dpaReference: access.dpaReference,
    validUntil: access.validUntil,
  };
}

async function recordDataRoomAccess(input: {
  principal: Principal;
  access: BankAccessContext;
  action: "overview" | "access_log";
  outcome: "served" | "suppressed";
  resultCount: number;
  suppressedCount: number;
}) {
  const queryFingerprint = createHash("sha256")
    .update(
      canonicalJson({
        action: input.action,
        bankPartyId: input.access.bankPartyId,
        scorecardSurface: "fixed-quarterly-cohorts-v1",
      }),
    )
    .digest("hex");
  const [row] = await getDb()
    .insert(creditDataRoomAccessEventsTable)
    .values({
      bankPartyId: input.access.bankPartyId,
      userId: input.access.userId,
      action: input.action,
      queryFingerprint,
      outcome: input.outcome,
      resultCount: input.resultCount,
      suppressedCount: input.suppressedCount,
    })
    .returning();
  await appendAudit({
    actorId: input.principal.userId,
    actorRole: input.principal.role,
    action: `credit.data_room.${input.action}`,
    entityType: "credit_data_room_access",
    entityId: row.id,
    after: {
      bankPartyId: input.access.bankPartyId,
      outcome: input.outcome,
      queryFingerprint,
    },
  });
  return row.id;
}

interface AggregateRow extends Record<string, unknown> {
  businesses: unknown;
  assessed: unknown;
  eligible: unknown;
  manual_review: unknown;
  ineligible: unknown;
  buyer_confirmed: unknown;
  settlement_observed: unknown;
  kyb_verified: unknown;
  data_through: unknown;
}

interface CohortRow extends AggregateRow {
  issue_year: unknown;
  issue_quarter: unknown;
  amount_band: unknown;
}

const AGGREGATE_CTES = sql`
  WITH latest_assessment AS (
    SELECT DISTINCT ON (invoice_id)
      id,
      invoice_id,
      supplier_party_id,
      decision,
      scorecard_version,
      ruleset_version,
      features,
      evaluated_at
    FROM credit_eligibility_assessments
    WHERE supplier_party_id IS NOT NULL
      AND decision IS NOT NULL
    ORDER BY invoice_id, evaluated_at DESC, id DESC
  ), latest_consent AS (
    SELECT DISTINCT ON (party_id)
      party_id,
      action
    FROM consent_records
    WHERE layer = 3
    ORDER BY party_id, created_at DESC, id DESC
  ), permitted AS (
    SELECT
      assessment.*,
      invoice.issue_date,
      CASE
        WHEN invoice.currency = 'NGN' THEN invoice.grand_total::numeric
        WHEN invoice.fx_rate_to_ngn IS NOT NULL AND invoice.fx_rate_to_ngn::numeric > 0
          THEN invoice.grand_total::numeric * invoice.fx_rate_to_ngn::numeric
        ELSE NULL
      END AS amount_ngn
    FROM latest_assessment assessment
    JOIN invoices invoice ON invoice.id = assessment.invoice_id
    JOIN latest_consent consent
      ON consent.party_id = assessment.supplier_party_id
     AND consent.action = 'grant'
    WHERE invoice.issue_date >= ${lagosTodaySql()} - interval '24 months'
      AND invoice.category IN ('b2b', 'b2g')
  )
`;

function aggregateSelect() {
  return sql`
    count(DISTINCT supplier_party_id)::int AS businesses,
    count(*)::int AS assessed,
    count(*) FILTER (WHERE decision = 'eligible')::int AS eligible,
    count(*) FILTER (WHERE decision = 'manual_review')::int AS manual_review,
    count(*) FILTER (WHERE decision = 'ineligible')::int AS ineligible,
    count(*) FILTER (WHERE coalesce((features ->> 'buyerConfirmed')::boolean, false))::int AS buyer_confirmed,
    count(*) FILTER (WHERE coalesce((features ->> 'settlementObserved')::boolean, false))::int AS settlement_observed,
    count(*) FILTER (WHERE coalesce((features ->> 'kybVerified')::boolean, false))::int AS kyb_verified,
    max(evaluated_at) AS data_through
  `;
}

function safeMetrics(row: AggregateRow) {
  const assessed = number(row.assessed);
  return {
    consentingBusinesses: number(row.businesses),
    assessedInvoices: assessed,
    eligibleInvoices: number(row.eligible),
    manualReviewInvoices: number(row.manual_review),
    ineligibleInvoices: number(row.ineligible),
    eligibleRate: pct(number(row.eligible), assessed),
    buyerConfirmationCoverage: pct(number(row.buyer_confirmed), assessed),
    settlementObservationCoverage: pct(
      number(row.settlement_observed),
      assessed,
    ),
    kybCoverage: pct(number(row.kyb_verified), assessed),
  };
}

export async function getBankDataRoom(principal: Principal) {
  const access = await assertBankDataRoomAccess(principal);
  const k = minimumCohortSize();
  const db = getDb();
  const [aggregateResult, cohortResult, versionResult] = await Promise.all([
    db.execute(
      sql`${AGGREGATE_CTES} SELECT ${aggregateSelect()} FROM permitted`,
    ),
    db.execute(sql`${AGGREGATE_CTES}
      SELECT
        extract(year FROM issue_date)::int AS issue_year,
        extract(quarter FROM issue_date)::int AS issue_quarter,
        CASE
          WHEN amount_ngn IS NULL THEN 'unavailable'
          WHEN amount_ngn < 250000 THEN 'under_250k'
          WHEN amount_ngn < 1000000 THEN '250k_to_1m'
          WHEN amount_ngn < 5000000 THEN '1m_to_5m'
          WHEN amount_ngn < 20000000 THEN '5m_to_20m'
          ELSE '20m_plus'
        END AS amount_band,
        ${aggregateSelect()}
      FROM permitted
      GROUP BY issue_year, issue_quarter, amount_band
      ORDER BY issue_year DESC, issue_quarter DESC, amount_band
      LIMIT 80
    `),
    db.execute(sql`${AGGREGATE_CTES}
      SELECT
        array_agg(DISTINCT scorecard_version ORDER BY scorecard_version) AS scorecard_versions,
        array_agg(DISTINCT ruleset_version ORDER BY ruleset_version) AS ruleset_versions
      FROM permitted
    `),
  ]);
  const aggregate = (aggregateResult.rows[0] ?? {}) as AggregateRow;
  const eligiblePopulation = number(aggregate.businesses) >= k;
  const cohorts = (cohortResult.rows as CohortRow[]).filter(
    (row) => number(row.businesses) >= k,
  );
  const suppressedCells = cohortResult.rows.length - cohorts.length;
  const accessEventId = await recordDataRoomAccess({
    principal,
    access,
    action: "overview",
    outcome: eligiblePopulation ? "served" : "suppressed",
    resultCount: eligiblePopulation ? cohorts.length : 0,
    suppressedCount: eligiblePopulation
      ? suppressedCells
      : cohortResult.rows.length + 1,
  });
  const versions = (versionResult.rows[0] ?? {}) as Record<string, unknown>;
  return {
    generatedAt: new Date().toISOString(),
    dataThrough: eligiblePopulation
      ? nullableIso(aggregate.data_through)
      : null,
    available: eligiblePopulation,
    accessEventId,
    privacy: {
      minimumCohortSize: k,
      suppressedCells: eligiblePopulation
        ? suppressedCells
        : cohortResult.rows.length + 1,
      exactAmountsShared: false,
      directIdentifiersShared: false,
      rawExportsEnabled: false,
      layer3ConsentRequired: true,
      dateGranularity: "quarter",
      amountGranularity: "fixed_band",
    },
    assurance: {
      dpaReference: access.dpaReference,
      accessValidUntil: access.validUntil?.toISOString() ?? null,
      scorecardVersions: eligiblePopulation
        ? ((versions.scorecard_versions as string[] | null) ?? [])
        : [],
      rulesetVersions: eligiblePopulation
        ? ((versions.ruleset_versions as string[] | null) ?? [])
        : [],
      decisionsAreDeterministic: true,
      backtestsAreStructuralOnly: true,
    },
    metrics: eligiblePopulation ? safeMetrics(aggregate) : null,
    cohorts: eligiblePopulation
      ? cohorts.map((row) => {
          const assessed = number(row.assessed);
          return {
            period: `${number(row.issue_year)} Q${number(row.issue_quarter)}`,
            amountBand: String(row.amount_band),
            businesses: number(row.businesses),
            assessedInvoices: assessed,
            eligibleRate: pct(number(row.eligible), assessed),
            manualReviewRate: pct(number(row.manual_review), assessed),
            ineligibleRate: pct(number(row.ineligible), assessed),
            buyerConfirmationCoverage: pct(
              number(row.buyer_confirmed),
              assessed,
            ),
            settlementObservationCoverage: pct(
              number(row.settlement_observed),
              assessed,
            ),
            kybCoverage: pct(number(row.kyb_verified), assessed),
          };
        })
      : [],
  };
}

export async function listBankDataRoomAccess(
  principal: Principal,
  limit: number,
) {
  const access = await assertBankDataRoomAccess(principal);
  const rows = await getDb()
    .select({
      id: creditDataRoomAccessEventsTable.id,
      userId: creditDataRoomAccessEventsTable.userId,
      action: creditDataRoomAccessEventsTable.action,
      outcome: creditDataRoomAccessEventsTable.outcome,
      createdAt: creditDataRoomAccessEventsTable.createdAt,
    })
    .from(creditDataRoomAccessEventsTable)
    .where(eq(creditDataRoomAccessEventsTable.bankPartyId, access.bankPartyId))
    .orderBy(
      desc(creditDataRoomAccessEventsTable.createdAt),
      desc(creditDataRoomAccessEventsTable.id),
    )
    .limit(limit);
  await recordDataRoomAccess({
    principal,
    access,
    action: "access_log",
    outcome: "served",
    resultCount: rows.length,
    suppressedCount: 0,
  });
  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    action: row.action,
    outcome: row.outcome,
    createdAt: row.createdAt.toISOString(),
  }));
}
