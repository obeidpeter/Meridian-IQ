import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

export interface BuyerPilotEvidence {
  tinValidated: boolean;
  supplierCount: number;
  invoiceCount: number;
  stampedCount: number;
  responseCount: number;
  responseRate: number | null;
  paidSignals: number;
}

export function assessBuyerPilot(evidence: BuyerPilotEvidence): {
  readinessScore: number;
  stage: "discovery" | "invited" | "live" | "proving" | "scale_ready";
  blockers: string[];
} {
  let readinessScore = 0;
  const blockers: string[] = [];

  if (evidence.tinValidated) readinessScore += 15;
  else blockers.push("Validate the buyer TIN");

  if (evidence.supplierCount >= 2) readinessScore += 15;
  else blockers.push("Connect at least two participating suppliers");

  if (evidence.invoiceCount >= 3) readinessScore += 10;
  else blockers.push("Flow at least three pilot invoices");

  if (evidence.stampedCount >= 3) readinessScore += 20;
  else blockers.push("Produce three stamped invoice records");

  if (evidence.responseCount > 0) readinessScore += 10;
  else blockers.push("Capture the buyer's first confirmation response");

  if ((evidence.responseRate ?? 0) >= 0.5) readinessScore += 20;
  else if (evidence.responseCount > 0) {
    blockers.push("Raise confirmation response coverage above 50%");
  }

  if (evidence.paidSignals > 0) readinessScore += 10;
  else blockers.push("Record the first buyer payment-status signal");

  const stage =
    readinessScore >= 85
      ? "scale_ready"
      : readinessScore >= 65
        ? "proving"
        : readinessScore >= 40
          ? "live"
          : readinessScore >= 20
            ? "invited"
            : "discovery";
  return { readinessScore, stage, blockers };
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined
    ? null
    : Number(Number(value).toFixed(2));
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | number | Date).toISOString();
}

export async function getBuyerPilotWorkspace() {
  const db = getDb();
  const result = await db.execute(sql`
    WITH latest_confirmation AS (
      SELECT DISTINCT ON (invoice_id)
        invoice_id,
        state,
        created_at
      FROM confirmations
      ORDER BY invoice_id, created_at DESC, id DESC
    ), latest_request AS (
      SELECT DISTINCT ON (invoice_id)
        invoice_id,
        created_at AS requested_at
      FROM confirmations
      WHERE state = 'requested'
      ORDER BY invoice_id, created_at DESC, id DESC
    ), response_times AS (
      SELECT
        request.invoice_id,
        request.requested_at,
        min(response.created_at) AS responded_at
      FROM latest_request request
      LEFT JOIN confirmations response
        ON response.invoice_id = request.invoice_id
       AND response.state IN ('confirmed', 'queried', 'rejected')
       AND response.created_at >= request.requested_at
      GROUP BY request.invoice_id, request.requested_at
    ), paid AS (
      SELECT invoice_id, count(*)::int AS signals, max(created_at) AS last_paid_at
      FROM settlement_events
      WHERE source IN ('buyer_flag', 'payer_flag')
        AND payment_status = 'paid'
      GROUP BY invoice_id
    )
    SELECT
      buyer.id AS buyer_party_id,
      buyer.legal_name AS buyer_name,
      buyer.tin_validated,
      count(DISTINCT invoice.supplier_party_id)::int AS supplier_count,
      count(*)::int AS invoice_count,
      count(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM stamp_records stamp WHERE stamp.invoice_id = invoice.id
        )
      )::int AS stamped_count,
      count(*) FILTER (WHERE latest.state = 'requested')::int AS pending_confirmations,
      count(request.responded_at)::int AS response_count,
      count(*) FILTER (WHERE latest.state = 'confirmed')::int AS confirmed_count,
      count(request.invoice_id)::int AS request_count,
      coalesce(sum(paid.signals), 0)::int AS paid_signals,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (request.responded_at - request.requested_at)) / 3600.0
      ) FILTER (WHERE request.responded_at IS NOT NULL) AS median_response_hours,
      max(
        greatest(
          invoice.updated_at,
          coalesce(latest.created_at, invoice.updated_at),
          coalesce(paid.last_paid_at, invoice.updated_at)
        )
      ) AS last_activity_at
    FROM parties buyer
    JOIN invoices invoice ON invoice.buyer_party_id = buyer.id
    LEFT JOIN latest_confirmation latest ON latest.invoice_id = invoice.id
    LEFT JOIN response_times request ON request.invoice_id = invoice.id
    LEFT JOIN paid ON paid.invoice_id = invoice.id
    WHERE buyer.type = 'buyer'
      AND invoice.category IN ('b2b', 'b2g')
    GROUP BY buyer.id, buyer.legal_name, buyer.tin_validated
    ORDER BY buyer.legal_name
  `);

  const pilots = result.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const responseCount = number(row.response_count);
    const requestCount = number(row.request_count);
    const evidence: BuyerPilotEvidence = {
      tinValidated: Boolean(row.tin_validated),
      supplierCount: number(row.supplier_count),
      invoiceCount: number(row.invoice_count),
      stampedCount: number(row.stamped_count),
      responseCount,
      responseRate:
        requestCount > 0
          ? Number((responseCount / requestCount).toFixed(4))
          : null,
      paidSignals: number(row.paid_signals),
    };
    return {
      buyerPartyId: String(row.buyer_party_id),
      buyerName: String(row.buyer_name),
      ...evidence,
      pendingConfirmations: number(row.pending_confirmations),
      confirmedCount: number(row.confirmed_count),
      medianResponseHours: nullableNumber(row.median_response_hours),
      lastActivityAt: nullableIso(row.last_activity_at),
      ...assessBuyerPilot(evidence),
    };
  });

  const cohortResult = await db.execute(sql`
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
      count(responded_at)::int AS responses,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM (responded_at - requested_at)) / 3600.0
      ) FILTER (WHERE responded_at IS NOT NULL) AS median_response_hours
    FROM responses
  `);
  const cohort = (cohortResult.rows[0] ?? {}) as Record<string, unknown>;
  const requests30d = number(cohort.requests);
  const responses30d = number(cohort.responses);
  const activeCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;

  return {
    generatedAt: new Date().toISOString(),
    anchorBuyers: pilots.length,
    activeBuyers30d: pilots.filter(
      (pilot) =>
        pilot.lastActivityAt !== null &&
        new Date(pilot.lastActivityAt).getTime() >= activeCutoff,
    ).length,
    pendingConfirmations: pilots.reduce(
      (total, pilot) => total + pilot.pendingConfirmations,
      0,
    ),
    confirmationResponses30d: responses30d,
    buyerResponseRate30d:
      requests30d > 0 ? Number((responses30d / requests30d).toFixed(4)) : null,
    medianResponseHours: nullableNumber(cohort.median_response_hours),
    pilots: pilots.sort(
      (a, b) =>
        b.readinessScore - a.readinessScore ||
        a.buyerName.localeCompare(b.buyerName),
    ),
  };
}
