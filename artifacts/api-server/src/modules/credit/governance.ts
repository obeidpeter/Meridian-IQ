import { desc, sql } from "drizzle-orm";
import { creditBacktestRunsTable, getDb } from "@workspace/db";
import { listFlags } from "../flags/flags";
import { CREDIT_BACKTEST_MIN_SAMPLE, backtestView } from "./service";
import {
  CREDIT_POLICY,
  CREDIT_RULESET_VERSION,
  CREDIT_SCORECARD_VERSION,
} from "./engine";
import { COLLECTION_ACCOUNT_FEED_SPECIFICATION } from "./feed-spec";

const intEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const number = (value: unknown): number => Number(value ?? 0);

function evidenceDate(name: string): string | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export async function getCreditGovernance() {
  const db = getDb();
  const [
    observableResult,
    assessmentResult,
    kybResult,
    bankResult,
    accessResult,
  ] = await Promise.all([
    db.execute(sql`
        WITH latest_confirmation AS (
          SELECT DISTINCT ON (invoice_id) invoice_id, state
          FROM confirmations
          ORDER BY invoice_id, created_at DESC, id DESC
        ), approved_settlement AS (
          SELECT DISTINCT invoice_id
          FROM settlement_events
          WHERE source IN ('statement_match', 'collection_account')
             OR (source = 'buyer_flag' AND payment_status = 'paid')
        )
        SELECT
          count(DISTINCT invoice.supplier_party_id)::int AS businesses,
          count(*)::int AS invoices,
          count(*) FILTER (WHERE latest.state = 'confirmed')::int AS buyer_confirmed,
          count(*) FILTER (WHERE settlement.invoice_id IS NOT NULL)::int AS settlement_observed,
          count(*) FILTER (
            WHERE latest.state = 'confirmed' AND settlement.invoice_id IS NOT NULL
          )::int AS mandatory_source_complete
        FROM invoices invoice
        JOIN stamp_records stamp ON stamp.invoice_id = invoice.id
        LEFT JOIN latest_confirmation latest ON latest.invoice_id = invoice.id
        LEFT JOIN approved_settlement settlement ON settlement.invoice_id = invoice.id
        WHERE invoice.category IN ('b2b', 'b2g')
          AND invoice.status IN ('stamped', 'confirmed', 'settled')
      `),
    db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (invoice_id) *
          FROM credit_eligibility_assessments
          WHERE decision IS NOT NULL
          ORDER BY invoice_id, evaluated_at DESC, id DESC
        ), latest_consent AS (
          SELECT DISTINCT ON (party_id) party_id, action
          FROM consent_records
          WHERE layer = 3
          ORDER BY party_id, created_at DESC, id DESC
        )
        SELECT
          count(*)::int AS assessments,
          count(DISTINCT latest.supplier_party_id)::int AS assessed_businesses,
          count(*) FILTER (WHERE latest.decision = 'eligible')::int AS eligible,
          count(*) FILTER (WHERE latest.decision = 'manual_review')::int AS manual_review,
          count(*) FILTER (WHERE latest.decision = 'ineligible')::int AS ineligible,
          count(*) FILTER (
            WHERE coalesce((latest.features ->> 'buyerConfirmed')::boolean, false)
          )::int AS buyer_confirmed,
          count(*) FILTER (
            WHERE coalesce((latest.features ->> 'settlementObserved')::boolean, false)
          )::int AS settlement_observed,
          count(*) FILTER (
            WHERE coalesce((latest.features ->> 'kybVerified')::boolean, false)
          )::int AS kyb_verified,
          count(DISTINCT consent.party_id) FILTER (WHERE consent.action = 'grant')::int AS consenting_businesses,
          max(latest.evaluated_at) AS data_through
        FROM latest
        LEFT JOIN latest_consent consent
          ON consent.party_id = latest.supplier_party_id
      `),
    db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (firm_id, party_id) status, expires_at
          FROM credit_kyb_checks
          ORDER BY firm_id, party_id, checked_at DESC, id DESC
        )
        SELECT
          count(*)::int AS checked,
          count(*) FILTER (
            WHERE status = 'verified' AND expires_at > now()
          )::int AS verified,
          count(*) FILTER (WHERE expires_at <= now())::int AS expired,
          count(*) FILTER (WHERE status IN ('review', 'failed'))::int AS attention
        FROM latest
      `),
    db.execute(sql`
        WITH latest AS (
          SELECT DISTINCT ON (access.user_id)
            access.user_id,
            access.action,
            access.dpa_reference,
            access.dpa_executed_at,
            access.valid_until,
            users.totp_enabled_at
          FROM credit_bank_access_events access
          JOIN users ON users.id = access.user_id
          ORDER BY access.user_id, access.created_at DESC, access.id DESC
        )
        SELECT
          count(*)::int AS governed_users,
          count(*) FILTER (WHERE totp_enabled_at IS NOT NULL)::int AS mfa_users,
          count(*) FILTER (
            WHERE action = 'grant'
              AND dpa_reference IS NOT NULL
              AND dpa_executed_at <= now()
              AND (valid_until IS NULL OR valid_until > now())
              AND totp_enabled_at IS NOT NULL
          )::int AS active_users
        FROM latest
      `),
    db.execute(sql`
        SELECT
          count(*)::int AS views_30d,
          count(DISTINCT user_id)::int AS viewers_30d,
          count(*) FILTER (WHERE outcome = 'suppressed')::int AS suppressed_30d,
          max(created_at) AS last_access_at
        FROM credit_data_room_access_events
        WHERE created_at >= now() - interval '30 days'
      `),
  ]);
  const [latestBacktest] = await db
    .select()
    .from(creditBacktestRunsTable)
    .orderBy(desc(creditBacktestRunsTable.createdAt))
    .limit(1);
  const flags = await listFlags();
  const creditFlag = flags.find((item) => item.key === "credit_readiness");
  const dataRoomFlag = flags.find((item) => item.key === "bank_data_room");
  const observable = (observableResult.rows[0] ?? {}) as Record<
    string,
    unknown
  >;
  const assessment = (assessmentResult.rows[0] ?? {}) as Record<
    string,
    unknown
  >;
  const kyb = (kybResult.rows[0] ?? {}) as Record<string, unknown>;
  const bank = (bankResult.rows[0] ?? {}) as Record<string, unknown>;
  const access = (accessResult.rows[0] ?? {}) as Record<string, unknown>;
  const targetBusinesses = intEnv("CREDIT_PILOT_MIN_BUSINESSES", 300);
  const dpiaApprovedAt = evidenceDate("CREDIT_DPIA_APPROVED_AT");
  const collectionFeedAgreedAt = evidenceDate(
    "CREDIT_COLLECTION_FEED_AGREED_AT",
  );
  const bankMouReference =
    process.env.CREDIT_BANK_MOU_REFERENCE?.trim() || null;
  const collectionFeedAgreementReference =
    process.env.CREDIT_COLLECTION_FEED_AGREEMENT_REF?.trim() || null;
  const blockers: string[] = [];
  if (number(observable.businesses) < targetBusinesses) {
    blockers.push(
      `Reach ${targetBusinesses} credit-observable businesses before activation.`,
    );
  }
  if (!dpiaApprovedAt) blockers.push("Approve and date the R3 DPIA.");
  if (!bankMouReference)
    blockers.push("Record the conditional bank MOU reference.");
  if (!collectionFeedAgreedAt || !collectionFeedAgreementReference) {
    blockers.push(
      "Agree and evidence the collection-account feed profile with the bank.",
    );
  }
  if (number(bank.active_users) < 1) {
    blockers.push("Provision at least one MFA- and DPA-governed bank user.");
  }
  if (!latestBacktest?.passed) {
    blockers.push(
      `Pass a structural replay back-test over at least ${CREDIT_BACKTEST_MIN_SAMPLE} assessments.`,
    );
  }

  const assessed = number(assessment.assessments);
  return {
    generatedAt: new Date().toISOString(),
    activationReady: blockers.length === 0,
    blockers,
    versions: {
      scorecard: CREDIT_SCORECARD_VERSION,
      ruleset: CREDIT_RULESET_VERSION,
      collectionFeed: COLLECTION_ACCOUNT_FEED_SPECIFICATION.version,
    },
    policy: {
      maxInvoiceAmountNgn: String(CREDIT_POLICY.maxInvoiceAmountNgn),
      maxSupplierOutstandingNgn: String(
        CREDIT_POLICY.maxSupplierOutstandingNgn,
      ),
      maxBuyerConcentrationBps: CREDIT_POLICY.maxBuyerConcentrationBps,
      volumeAnomalyMultiplierBps: CREDIT_POLICY.volumeAnomalyMultiplierBps,
      minimumHistoryInvoices: CREDIT_POLICY.minimumHistoryInvoices,
      permittedSettlementSources: [...CREDIT_POLICY.permittedSettlementSources],
    },
    featurePosture: {
      creditReadinessEnabled: creditFlag?.enabled ?? false,
      creditPilotFirms: creditFlag?.overrideCount ?? 0,
      bankDataRoomEnabled: dataRoomFlag?.enabled ?? false,
      bankDataRoomPilotFirms: dataRoomFlag?.overrideCount ?? 0,
    },
    activationEvidence: {
      targetBusinesses,
      observableBusinesses: number(observable.businesses),
      observableInvoices: number(observable.invoices),
      mandatorySourceComplete: number(observable.mandatory_source_complete),
      dpiaApprovedAt,
      bankMouReference,
      collectionFeedAgreedAt,
      collectionFeedAgreementReference,
    },
    assessments: {
      total: assessed,
      businesses: number(assessment.assessed_businesses),
      consentingBusinesses: number(assessment.consenting_businesses),
      eligible: number(assessment.eligible),
      manualReview: number(assessment.manual_review),
      ineligible: number(assessment.ineligible),
      buyerConfirmationCoverage:
        assessed > 0 ? number(assessment.buyer_confirmed) / assessed : null,
      settlementObservationCoverage:
        assessed > 0 ? number(assessment.settlement_observed) / assessed : null,
      kybCoverage:
        assessed > 0 ? number(assessment.kyb_verified) / assessed : null,
      dataThrough: assessment.data_through
        ? new Date(assessment.data_through as string).toISOString()
        : null,
    },
    kyb: {
      checked: number(kyb.checked),
      verified: number(kyb.verified),
      expired: number(kyb.expired),
      attention: number(kyb.attention),
    },
    bankAccess: {
      governedUsers: number(bank.governed_users),
      mfaUsers: number(bank.mfa_users),
      activeUsers: number(bank.active_users),
      views30d: number(access.views_30d),
      viewers30d: number(access.viewers_30d),
      suppressedViews30d: number(access.suppressed_30d),
      lastAccessAt: access.last_access_at
        ? new Date(access.last_access_at as string).toISOString()
        : null,
    },
    latestBacktest: latestBacktest ? backtestView(latestBacktest) : null,
  };
}
