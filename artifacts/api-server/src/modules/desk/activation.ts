import { eq, sql } from "drizzle-orm";
import {
  confirmationsTable,
  engagementsTable,
  escalationsTable,
  featureFlagsTable,
  firmSubscriptionsTable,
  getDb,
  invoicesTable,
  matchProposalsTable,
  onboardingProspectsTable,
  stampRecordsTable,
} from "@workspace/db";

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Number((part / whole).toFixed(4)) : null;
}

// The activation view is deliberately derived from the operational spine.
// Targets and presentation live in the console; this module reports evidence,
// without a second KPI store that can drift away from the underlying records.
export async function getActivationMetrics() {
  const db = getDb();

  const [subscriptions] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(firmSubscriptionsTable)
    .where(eq(firmSubscriptionsTable.status, "active"));
  const [clients] = await db
    .select({
      n: sql<number>`count(distinct ${engagementsTable.clientPartyId})::int`,
    })
    .from(engagementsTable)
    .where(sql`${engagementsTable.status} IN ('open', 'in_progress')`);
  const [prospects] = await db
    .select({
      total: sql<number>`count(*)::int`,
      onboarding: sql<number>`count(*) filter (where ${onboardingProspectsTable.stage} = 'onboarding')::int`,
      converted: sql<number>`count(*) filter (where ${onboardingProspectsTable.stage} = 'active')::int`,
    })
    .from(onboardingProspectsTable);
  const [stamps] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stampRecordsTable);
  const [median] = await db
    .select({
      hours: sql<number | null>`percentile_cont(0.5) within group (
        order by extract(epoch from ${stampRecordsTable.createdAt} - ${invoicesTable.createdAt}) / 3600.0
      )`,
    })
    .from(stampRecordsTable)
    .innerJoin(
      invoicesTable,
      eq(stampRecordsTable.invoiceId, invoicesTable.id),
    );

  const failureRows = await db.execute(sql`
    WITH failed AS (
      SELECT DISTINCT invoice_id
      FROM invoice_lifecycle_events
      WHERE to_status = 'failed'
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE i.status IN ('stamped', 'confirmed', 'settled', 'credited')
          AND NOT EXISTS (
            SELECT 1 FROM escalations e WHERE e.invoice_id = failed.invoice_id
          )
      )::int AS self_resolved
    FROM failed
    JOIN invoices i ON i.id = failed.invoice_id
  `);
  const failure = (failureRows.rows[0] ?? {
    total: 0,
    self_resolved: 0,
  }) as { total: number; self_resolved: number };

  const observableRows = await db.execute(sql`
    SELECT count(DISTINCT i.supplier_party_id)::int AS count
    FROM invoices i
    WHERE EXISTS (SELECT 1 FROM stamp_records s WHERE s.invoice_id = i.id)
      AND (
        EXISTS (SELECT 1 FROM confirmations c WHERE c.invoice_id = i.id)
        OR EXISTS (SELECT 1 FROM settlement_events se WHERE se.invoice_id = i.id)
      )
  `);
  const creditObservableCount = Number(
    (observableRows.rows[0] as { count?: number } | undefined)?.count ?? 0,
  );

  const [confirmationEvents] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(confirmationsTable)
    .where(sql`${confirmationsTable.createdAt} > now() - interval '30 days'`);
  const confirmationCohortRows = await db.execute(sql`
    WITH requests AS (
      SELECT invoice_id, min(created_at) AS requested_at
      FROM confirmations
      WHERE state = 'requested'
        AND created_at > now() - interval '30 days'
      GROUP BY invoice_id
    ), responses AS (
      SELECT
        requests.invoice_id,
        requests.requested_at,
        min(c.created_at) AS responded_at
      FROM requests
      LEFT JOIN confirmations c
        ON c.invoice_id = requests.invoice_id
       AND c.state IN ('confirmed', 'queried', 'rejected')
       AND c.created_at >= requests.requested_at
      GROUP BY requests.invoice_id, requests.requested_at
    )
    SELECT
      count(*)::int AS requests,
      count(responded_at)::int AS responses
    FROM responses
  `);
  const confirmationCohort = (confirmationCohortRows.rows[0] ?? {
    requests: 0,
    responses: 0,
  }) as { requests: number; responses: number };

  const anchorRows = await db.execute(sql`
    SELECT count(DISTINCT i.buyer_party_id)::int AS count
    FROM invoices i
    WHERE i.category IN ('b2b', 'b2g')
      AND EXISTS (SELECT 1 FROM stamp_records s WHERE s.invoice_id = i.id)
  `);
  const anchorBuyers = Number(
    (anchorRows.rows[0] as { count?: number } | undefined)?.count ?? 0,
  );

  const [proposals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${matchProposalsTable.status} = 'accepted')::int`,
    })
    .from(matchProposalsTable);
  const [openEscalations] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(escalationsTable)
    .where(eq(escalationsTable.status, "open"));
  const releaseRows = await db
    .select({
      releaseTag: featureFlagsTable.releaseTag,
      totalFlags: sql<number>`count(*)::int`,
      enabledFlags: sql<number>`count(*) filter (where ${featureFlagsTable.enabled})::int`,
    })
    .from(featureFlagsTable)
    .groupBy(featureFlagsTable.releaseTag)
    .orderBy(featureFlagsTable.releaseTag);

  const featureFlagsTotal = releaseRows.reduce(
    (total, row) => total + row.totalFlags,
    0,
  );
  const featureFlagsEnabled = releaseRows.reduce(
    (total, row) => total + row.enabledFlags,
    0,
  );

  return {
    subscribedFirms: subscriptions?.n ?? 0,
    activeClients: clients?.n ?? 0,
    namedProspects: prospects?.total ?? 0,
    onboardingProspects: prospects?.onboarding ?? 0,
    convertedProspects: prospects?.converted ?? 0,
    prospectConversionRate: ratio(
      prospects?.converted ?? 0,
      prospects?.total ?? 0,
    ),
    stampedInvoices: stamps?.n ?? 0,
    medianHoursToStamp:
      median?.hours === null || median?.hours === undefined
        ? null
        : Number(Number(median.hours).toFixed(2)),
    failedInvoicesTotal: Number(failure.total),
    failureSelfResolutionRate: ratio(
      Number(failure.self_resolved),
      Number(failure.total),
    ),
    creditObservableCount,
    confirmationsLast30d: confirmationEvents?.n ?? 0,
    confirmationRequests30d: Number(confirmationCohort.requests),
    confirmationResponses30d: Number(confirmationCohort.responses),
    buyerResponseRate30d: ratio(
      Number(confirmationCohort.responses),
      Number(confirmationCohort.requests),
    ),
    anchorBuyers,
    reconciliationAcceptRate: ratio(
      proposals?.accepted ?? 0,
      proposals?.total ?? 0,
    ),
    openEscalations: openEscalations?.n ?? 0,
    featureFlagsEnabled,
    featureFlagsTotal,
    releaseReadiness: releaseRows.map((row) => ({
      releaseTag: row.releaseTag,
      enabledFlags: row.enabledFlags,
      totalFlags: row.totalFlags,
      status:
        row.enabledFlags === 0
          ? ("dark" as const)
          : row.enabledFlags === row.totalFlags
            ? ("ready" as const)
            : ("partial" as const),
    })),
  };
}
