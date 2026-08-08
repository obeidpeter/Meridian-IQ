import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";
import { verifyChain } from "./audit";

const evidenceUnion = sql`
  SELECT
    stamp.id::text AS entity_id,
    'invoice_stamp'::text AS kind,
    'Stamped invoice / ' || invoice.invoice_number AS title,
    firm.name AS firm_name,
    client.legal_name AS client_name,
    invoice.supplier_party_id::text AS client_party_id,
    stamp.irn AS reference,
    stamp.created_at AS recorded_at,
    'append_only'::text AS integrity
  FROM stamp_records stamp
  JOIN invoices invoice ON invoice.id = stamp.invoice_id
  JOIN firms firm ON firm.id = invoice.firm_id
  JOIN parties client ON client.id = invoice.supplier_party_id

  UNION ALL

  SELECT
    filing.id::text,
    'filing_acknowledgement'::text,
    upper(filing.tax_type) || ' filing / ' || filing.period,
    firm.name,
    client.legal_name,
    filing.client_party_id::text,
    filing.filed_reference,
    filing.updated_at,
    'tamper_evident'::text
  FROM filing_returns filing
  JOIN firms firm ON firm.id = filing.firm_id
  JOIN parties client ON client.id = filing.client_party_id
  WHERE filing.status = 'filed'

  UNION ALL

  SELECT
    obligation.id::text,
    'obligation_resolution'::text,
    obligation.authority || ' response / ' || replace(obligation.notice_type, '_', ' '),
    firm.name,
    client.legal_name,
    obligation.client_party_id::text,
    obligation.reference,
    obligation.updated_at,
    'tamper_evident'::text
  FROM obligations obligation
  JOIN firms firm ON firm.id = obligation.firm_id
  JOIN parties client ON client.id = obligation.client_party_id
  WHERE obligation.status IN ('responded', 'closed')

  UNION ALL

  SELECT
    settlement.id::text,
    'settlement_signal'::text,
    'Settlement evidence / ' || invoice.invoice_number,
    firm.name,
    client.legal_name,
    invoice.supplier_party_id::text,
    replace(settlement.source::text, '_', ' '),
    settlement.created_at,
    'append_only'::text
  FROM settlement_events settlement
  JOIN invoices invoice ON invoice.id = settlement.invoice_id
  JOIN firms firm ON firm.id = invoice.firm_id
  JOIN parties client ON client.id = invoice.supplier_party_id
  WHERE settlement.source <> 'uploaded_evidence'
`;

function number(value: unknown): number {
  return Number(value ?? 0);
}

export async function getEvidenceVaultWorkspace() {
  const db = getDb();
  const summaryResult = await db.execute(sql`
    WITH evidence AS (${evidenceUnion})
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE recorded_at > now() - interval '30 days'
      )::int AS last_30d,
      count(*) FILTER (
        WHERE integrity = 'append_only'
          AND recorded_at > now() - interval '30 days'
      )::int AS append_only_30d
    FROM evidence
  `);
  const itemResult = await db.execute(sql`
    WITH evidence AS (${evidenceUnion})
    SELECT *
    FROM evidence
    ORDER BY recorded_at DESC, entity_id DESC
    LIMIT 80
  `);
  const retentionResult = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status <> 'draft')::int AS eligible,
      count(*) FILTER (
        WHERE status <> 'draft'
          AND (retention_until IS NOT NULL OR legal_hold)
      )::int AS covered,
      count(*) FILTER (WHERE legal_hold)::int AS legal_holds
    FROM invoices
  `);
  const verification = await verifyChain();

  const summary = (summaryResult.rows[0] ?? {}) as Record<string, unknown>;
  const retention = (retentionResult.rows[0] ?? {}) as Record<string, unknown>;
  const eligible = number(retention.eligible);
  const covered = number(retention.covered);
  const retentionCoverageRate =
    eligible > 0 ? Number((covered / eligible).toFixed(4)) : null;
  const appendOnlyCount = number(summary.append_only_30d);

  const items = itemResult.rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const kind = String(row.kind) as
      | "invoice_stamp"
      | "filing_acknowledgement"
      | "obligation_resolution"
      | "settlement_signal";
    return {
      key: `${kind}:${String(row.entity_id)}`,
      entityId: String(row.entity_id),
      kind,
      title: String(row.title),
      firmName: String(row.firm_name),
      clientName: String(row.client_name),
      reference:
        row.reference === null || row.reference === undefined
          ? null
          : String(row.reference),
      recordedAt: new Date(
        row.recorded_at as string | number | Date,
      ).toISOString(),
      integrity: String(row.integrity) as
        | "tamper_evident"
        | "append_only"
        | "recorded",
      actionHref:
        kind === "filing_acknowledgement"
          ? "/filing-desk"
          : kind === "obligation_resolution"
            ? "/audit"
            : "/audit",
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    totalArtifacts: number(summary.total),
    artifactsLast30d: number(summary.last_30d),
    auditChainValid: verification.valid,
    auditEventCount: verification.count,
    retentionCoverageRate,
    legalHolds: number(retention.legal_holds),
    items,
    trustControls: [
      {
        key: "audit_chain",
        label: "Tamper-evident audit chain",
        status: verification.valid
          ? ("healthy" as const)
          : ("critical" as const),
        detail: verification.valid
          ? `${verification.count} audit events verified in sequence.`
          : `Chain verification failed at sequence ${verification.brokenAtSeq ?? "unknown"}.`,
      },
      {
        key: "append_only",
        label: "Append-only operational evidence",
        status: appendOnlyCount > 0 ? ("healthy" as const) : ("watch" as const),
        detail: `${appendOnlyCount} recent immutable stamp or settlement records are indexed.`,
      },
      {
        key: "retention",
        label: "Retention and legal hold coverage",
        status:
          retentionCoverageRate === null || retentionCoverageRate >= 0.9
            ? ("healthy" as const)
            : ("watch" as const),
        detail:
          retentionCoverageRate === null
            ? "No submitted invoices currently require a retention window."
            : `${Math.round(retentionCoverageRate * 100)}% of submitted invoice records carry retention or legal-hold coverage.`,
      },
      {
        key: "human_authority",
        label: "Human-controlled authority actions",
        status: "healthy" as const,
        detail:
          "Filing acknowledgements and authority responses enter the vault only after a human records the act.",
      },
      {
        key: "pointer_messaging",
        label: "Pointer-only external messaging",
        status: "healthy" as const,
        detail:
          "Notifications carry entity pointers; documents and sensitive values remain behind authenticated APIs.",
      },
    ],
  };
}
