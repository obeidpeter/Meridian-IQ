import { sql } from "drizzle-orm";
import { getDb } from "@workspace/db";

interface ConnectionEvidence {
  connectionStatus: string;
  latestRunStatus: string | null;
  lastSyncAt: string | null;
  issue: string | null;
}

export function assessConnectionHealth(
  evidence: ConnectionEvidence,
  now = new Date(),
): {
  operationalState: "healthy" | "stale" | "incident";
  issue: string | null;
} {
  if (
    evidence.connectionStatus === "error" ||
    evidence.latestRunStatus === "failed"
  ) {
    return {
      operationalState: "incident",
      issue: evidence.issue ?? "The latest synchronization failed",
    };
  }
  if (
    evidence.connectionStatus === "paused" ||
    evidence.connectionStatus === "disabled"
  ) {
    return {
      operationalState: "stale",
      issue: "Connection is not active",
    };
  }
  if (!evidence.lastSyncAt) {
    return {
      operationalState: "stale",
      issue: "No successful synchronization has been recorded",
    };
  }
  const ageHours =
    (now.getTime() - new Date(evidence.lastSyncAt).getTime()) / 3_600_000;
  if (ageHours > 24) {
    return {
      operationalState: "stale",
      issue: `Last synchronized ${Math.floor(ageHours)} hours ago`,
    };
  }
  return { operationalState: "healthy", issue: null };
}

function number(value: unknown): number {
  return Number(value ?? 0);
}

function nullableIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | number | Date).toISOString();
}

export async function getIntegrationReliabilityWorkspace() {
  const db = getDb();
  const connectionResult = await db.execute(sql`
    SELECT
      connection.id::text,
      'erp'::text AS type,
      connection.connector_key,
      firm.name AS firm_name,
      client.legal_name AS client_name,
      connection.status::text AS connection_status,
      connection.last_sync_at,
      run.status::text AS latest_run_status,
      coalesce(run.pulled_count, 0)::int AS records_read,
      coalesce(run.imported_count, 0)::int AS records_written,
      coalesce(run.error_count, 0)::int AS error_count,
      coalesce(connection.last_error, run.error) AS issue
    FROM erp_connections connection
    JOIN firms firm ON firm.id = connection.firm_id
    JOIN parties client ON client.id = connection.client_party_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM erp_sync_runs candidate
      WHERE candidate.connection_id = connection.id
      ORDER BY candidate.started_at DESC, candidate.id DESC
      LIMIT 1
    ) run ON true

    UNION ALL

    SELECT
      connection.id::text,
      'bank_feed'::text,
      connection.connector_key,
      firm.name,
      client.legal_name,
      connection.status::text,
      connection.last_sync_at,
      run.status::text,
      coalesce(run.lines_pulled, 0)::int,
      coalesce(run.lines_pulled, 0)::int,
      CASE WHEN run.status = 'failed' THEN 1 ELSE 0 END::int,
      run.error
    FROM statement_connections connection
    JOIN firms firm ON firm.id = connection.firm_id
    JOIN parties client ON client.id = connection.client_party_id
    LEFT JOIN LATERAL (
      SELECT *
      FROM statement_sync_runs candidate
      WHERE candidate.connection_id = connection.id
      ORDER BY candidate.started_at DESC, candidate.id DESC
      LIMIT 1
    ) run ON true
  `);

  const now = new Date();
  const connections = connectionResult.rows
    .map((raw) => {
      const row = raw as Record<string, unknown>;
      const evidence: ConnectionEvidence = {
        connectionStatus: String(row.connection_status),
        latestRunStatus:
          row.latest_run_status === null || row.latest_run_status === undefined
            ? null
            : String(row.latest_run_status),
        lastSyncAt: nullableIso(row.last_sync_at),
        issue:
          row.issue === null || row.issue === undefined
            ? null
            : String(row.issue),
      };
      const assessed = assessConnectionHealth(evidence, now);
      return {
        id: String(row.id),
        type:
          row.type === "bank_feed" ? ("bank_feed" as const) : ("erp" as const),
        connectorKey: String(row.connector_key),
        firmName: String(row.firm_name),
        clientName: String(row.client_name),
        connectionStatus: evidence.connectionStatus,
        operationalState: assessed.operationalState,
        lastSyncAt: evidence.lastSyncAt,
        latestRunStatus: evidence.latestRunStatus,
        recordsRead: number(row.records_read),
        recordsWritten: number(row.records_written),
        errorCount: number(row.error_count),
        issue: assessed.issue,
      };
    })
    .sort(
      (a, b) =>
        (a.operationalState === "incident"
          ? 0
          : a.operationalState === "stale"
            ? 1
            : 2) -
          (b.operationalState === "incident"
            ? 0
            : b.operationalState === "stale"
              ? 1
              : 2) || a.clientName.localeCompare(b.clientName),
    );

  const qualityResult = await db.execute(sql`
    SELECT
      (
        SELECT count(*) FROM erp_sync_runs
        WHERE status = 'failed' AND started_at > now() - interval '24 hours'
      ) + (
        SELECT count(*) FROM statement_sync_runs
        WHERE status = 'failed' AND started_at > now() - interval '24 hours'
      ) AS failed_runs_24h,
      (
        SELECT count(*) FROM bank_statement_lines line
        JOIN bank_statements statement ON statement.id = line.statement_id
        WHERE line.parse_status = 'invalid'
          AND statement.created_at > now() - interval '30 days'
      ) + (
        SELECT coalesce(sum(error_count + skipped_count), 0)
        FROM erp_sync_runs
        WHERE started_at > now() - interval '30 days'
      ) AS invalid_rows_30d,
      (SELECT count(*) FROM outbox_events WHERE status = 'dead') AS dead_letters,
      (SELECT count(*) FROM firm_webhook_deliveries WHERE status = 'dead') AS dead_webhooks,
      (SELECT count(*) FROM rail_states WHERE state <> 'closed') AS open_rails
  `);
  const quality = (qualityResult.rows[0] ?? {}) as Record<string, unknown>;
  const failedRuns24h = number(quality.failed_runs_24h);
  const invalidRows30d = number(quality.invalid_rows_30d);
  const deadOutboxEvents = number(quality.dead_letters);
  const deadWebhooks = number(quality.dead_webhooks);
  const deadLetters = deadOutboxEvents + deadWebhooks;
  const openRails = number(quality.open_rails);
  const attentionConnections = connections.filter(
    (connection) => connection.operationalState !== "healthy",
  ).length;

  const qualitySignals = [
    {
      key: "connection_attention",
      label: "Connections needing attention",
      count: attentionConnections,
      severity:
        attentionConnections > 0 ? ("warning" as const) : ("info" as const),
      detail: "Paused, failed or more than 24 hours since the last sync.",
      actionHref: "/control-centre/reliability#connections",
    },
    {
      key: "failed_runs",
      label: "Failed runs (24 hours)",
      count: failedRuns24h,
      severity: failedRuns24h > 0 ? ("critical" as const) : ("info" as const),
      detail: "ERP and bank-feed runs with a terminal failure.",
      actionHref: "/control-centre/reliability#connections",
    },
    {
      key: "invalid_rows",
      label: "Rejected or skipped rows (30 days)",
      count: invalidRows30d,
      severity: invalidRows30d > 0 ? ("warning" as const) : ("info" as const),
      detail: "Rows that did not enter the canonical spine cleanly.",
      actionHref: "/control-centre/reliability#connections",
    },
    {
      key: "dead_letters",
      label: "Dead outbox events",
      count: deadOutboxEvents,
      severity:
        deadOutboxEvents > 0 ? ("critical" as const) : ("info" as const),
      detail: "Pipeline events that exhausted their retry budget.",
      actionHref: "/platform-ops",
    },
    {
      key: "dead_webhooks",
      label: "Dead webhook deliveries",
      count: deadWebhooks,
      severity: deadWebhooks > 0 ? ("critical" as const) : ("info" as const),
      detail: "Pointer-only notifications that exhausted delivery retries.",
      actionHref: "/platform-ops",
    },
    {
      key: "open_rails",
      label: "Degraded platform rails",
      count: openRails,
      severity: openRails > 0 ? ("critical" as const) : ("info" as const),
      detail: "Circuit breakers currently open or probing.",
      actionHref: "/platform-ops",
    },
  ];

  return {
    generatedAt: now.toISOString(),
    totalConnections: connections.length,
    healthyConnections: connections.length - attentionConnections,
    attentionConnections,
    failedRuns24h,
    invalidRows30d,
    deadLetters,
    openRails,
    connections,
    qualitySignals,
  };
}
