import { Router, type IRouter } from "express";
import { desc, eq, inArray, sql } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  railStatesTable,
  firmSubscriptionsTable,
  engagementsTable,
  stampRecordsTable,
  invoicesTable,
  confirmationsTable,
  matchProposalsTable,
  escalationsTable,
} from "@workspace/db";
import {
  ListDeadLettersResponse,
  ReplayDeadLetterParams,
  ReconcilePipelineResponse,
  ListRailStatesResponse,
  GetGateMetricsResponse,
  ListHealthAlertsResponse,
  GetRailConfigResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { assertCan } from "../modules/auth/rbac";
import {
  listDeadLetters,
  replayDead,
  reconcile,
} from "../modules/pipeline/pipeline";
import {
  RAIL_CIRCUIT_OPEN_ACTION,
  OUTBOX_DEAD_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
} from "../modules/desk/health-watch";
import { SPEND_ANOMALY_ACTION } from "../modules/clerk/spend-watch";
import { QUALITY_DROP_ACTION } from "../modules/clerk/quality-watch";
import { RESISTANCE_DROP_ACTION } from "../modules/clerk/resistance-watch";

const router: IRouter = Router();

router.get("/operator/dead-letters", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(ListDeadLettersResponse.parse(await listDeadLetters()));
});

router.post(
  "/operator/dead-letters/:id/replay",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.act");
    const params = parseOrThrow(ReplayDeadLetterParams, req.params);
    await replayDead(params.id);
    res.sendStatus(204);
  },
);

router.post("/operator/reconcile", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.act");
  const requeued = await reconcile();
  res.json(ReconcilePipelineResponse.parse({ requeued }));
});

router.get("/operator/rails", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb().select().from(railStatesTable);
  res.json(ListRailStatesResponse.parse(rows));
});

// The closed set of durable health-alert actions the Desk surfaces: the ops
// health watch's three conditions plus the clerk watch trio. Importing the
// constants (not re-typing the strings) keeps route and sweeps in lockstep.
const HEALTH_ALERT_ACTIONS = [
  RAIL_CIRCUIT_OPEN_ACTION,
  OUTBOX_DEAD_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
  SPEND_ANOMALY_ACTION,
  QUALITY_DROP_ACTION,
  RESISTANCE_DROP_ACTION,
];

// Read path for the watches' durable alerts: the audit ledger IS the alert
// store (append-only, cross-instance), so the Desk reads it back rather than
// keeping a second alert table. `detail` passes the alert's `after` evidence
// through — watch payloads are pointer-only by construction.
router.get("/operator/health-alerts", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb()
    .select({
      seq: auditEventsTable.seq,
      action: auditEventsTable.action,
      entityType: auditEventsTable.entityType,
      entityId: auditEventsTable.entityId,
      createdAt: auditEventsTable.createdAt,
      after: auditEventsTable.after,
    })
    .from(auditEventsTable)
    .where(inArray(auditEventsTable.action, HEALTH_ALERT_ACTIONS))
    .orderBy(desc(auditEventsTable.seq))
    .limit(50);
  res.json(
    ListHealthAlertsResponse.parse(
      rows.map((row) => ({
        seq: row.seq,
        action: row.action,
        entityType: row.entityType,
        entityId: row.entityId,
        createdAt: row.createdAt.toISOString(),
        detail: row.after ?? null,
      })),
    ),
  );
});

// Which env-lit rails this deployment has configured. PRESENCE BOOLEANS ONLY
// — the endpoint must never echo a value (it would be a secrets oracle); each
// note states the rail's unset semantics in one clause. Env is read per
// request, matching how every gate reads it.
const RAIL_CONFIG_ENTRIES: {
  key: string;
  label: string;
  env: string;
  note: string;
}[] = [
  {
    key: "inbound_email",
    label: "Inbound email intake",
    env: "INBOUND_EMAIL_TOKEN",
    note: "Fail-closed: unset keeps the inbound email rail dark.",
  },
  {
    key: "inbound_whatsapp",
    label: "Inbound WhatsApp intake",
    env: "INBOUND_WHATSAPP_TOKEN",
    note: "Fail-closed: unset keeps the inbound WhatsApp rail dark.",
  },
  {
    key: "messaging_relay",
    label: "Outbound messaging relay",
    env: "MESSAGING_WEBHOOK_URL",
    note: "Unset keeps every send on the in-process simulator.",
  },
  {
    key: "payment_provider",
    label: "Payment provider",
    env: "PAYMENT_PROVIDER_URL",
    note: "Unset keeps billing checkout on the simulated provider.",
  },
  {
    key: "payment_webhook",
    label: "Payment settlement webhook",
    env: "PAYMENT_WEBHOOK_TOKEN",
    note: "Fail-closed: unset means no settlement webhook exists at all.",
  },
  {
    key: "metrics_token",
    label: "Metrics scrape token",
    env: "METRICS_TOKEN",
    note: "Open when unset: setting it closes /api/metrics behind the secret.",
  },
  {
    key: "sweep_token",
    label: "Sweep trigger token",
    env: "SWEEP_TOKEN",
    note: "Open when unset: setting it closes /api/internal/sweep behind the secret.",
  },
  {
    key: "totp_required_roles",
    label: "TOTP-required roles",
    env: "TOTP_REQUIRED_ROLES",
    note: "Unset means TOTP stays opt-in for every role.",
  },
];

router.get("/operator/rail-config", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(
    GetRailConfigResponse.parse(
      RAIL_CONFIG_ENTRIES.map((entry) => ({
        key: entry.key,
        label: entry.label,
        configured: Boolean(process.env[entry.env]),
        note: entry.note,
      })),
    ),
  );
});

// Roadmap Appendix A ("Platform gates"): live measurement of the R1/R2 gate
// metrics from the spine — subscriptions, time-to-first-stamp, failure
// self-resolution, credit-observable count. Targets are roadmap constants and
// render client-side; this endpoint reports only what the data says.
router.get("/operator/gate-metrics", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const db = getDb();

  const [subs] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(firmSubscriptionsTable)
    .where(eq(firmSubscriptionsTable.status, "active"));
  const [clients] = await db
    .select({
      n: sql<number>`count(distinct ${engagementsTable.clientPartyId})::int`,
    })
    .from(engagementsTable);
  const [stamps] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(stampRecordsTable);
  // Median hours from invoice creation to stamp (gate target: < 48h).
  const [median] = await db
    .select({
      h: sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from ${stampRecordsTable.createdAt} - ${invoicesTable.createdAt}) / 3600.0)`,
    })
    .from(stampRecordsTable)
    .innerJoin(invoicesTable, eq(stampRecordsTable.invoiceId, invoicesTable.id));
  // Failure self-resolution (gate target: >= 80%): invoices that ever failed
  // and later reached a stamped state without a client escalation.
  const failureRows = await db.execute(sql`
    WITH failed AS (
      SELECT DISTINCT invoice_id FROM invoice_lifecycle_events WHERE to_status = 'failed'
    )
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE i.status IN ('stamped', 'confirmed', 'settled', 'credited')
          AND NOT EXISTS (SELECT 1 FROM escalations e WHERE e.invoice_id = f.invoice_id)
      )::int AS self_resolved
    FROM failed f
    JOIN invoices i ON i.id = f.invoice_id
  `);
  const failure = (failureRows.rows?.[0] ?? { total: 0, self_resolved: 0 }) as {
    total: number;
    self_resolved: number;
  };
  // Credit-observable (R2 north star, target 300): supplier parties with
  // stamped invoices flowing plus some confirmation or settlement signal.
  const observableRows = await db.execute(sql`
    SELECT count(DISTINCT i.supplier_party_id)::int AS n
    FROM invoices i
    WHERE EXISTS (SELECT 1 FROM stamp_records s WHERE s.invoice_id = i.id)
      AND i.supplier_party_id IN (
        SELECT i2.supplier_party_id FROM invoices i2
        WHERE EXISTS (SELECT 1 FROM confirmations c WHERE c.invoice_id = i2.id)
           OR EXISTS (SELECT 1 FROM settlement_events se WHERE se.invoice_id = i2.id)
      )
  `);
  const creditObservable = Number(
    (observableRows.rows?.[0] as { n?: number } | undefined)?.n ?? 0,
  );
  const [confirmations30d] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(confirmationsTable)
    .where(
      sql`${confirmationsTable.createdAt} > now() - interval '30 days'`,
    );
  const [proposals] = await db
    .select({
      total: sql<number>`count(*)::int`,
      accepted: sql<number>`count(*) filter (where ${matchProposalsTable.status} = 'accepted')::int`,
    })
    .from(matchProposalsTable);
  const [openEsc] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(escalationsTable)
    .where(eq(escalationsTable.status, "open"));

  res.json(
    GetGateMetricsResponse.parse({
      subscribedFirms: subs?.n ?? 0,
      activeClients: clients?.n ?? 0,
      stampedInvoices: stamps?.n ?? 0,
      medianHoursToStamp: median?.h === null || median?.h === undefined
        ? null
        : Number(median.h),
      failedInvoicesTotal: failure.total,
      failureSelfResolutionRate:
        failure.total > 0 ? failure.self_resolved / failure.total : null,
      creditObservableCount: creditObservable,
      confirmationsLast30d: confirmations30d?.n ?? 0,
      reconciliationAcceptRate:
        (proposals?.total ?? 0) > 0
          ? (proposals!.accepted ?? 0) / proposals!.total
          : null,
      openEscalations: openEsc?.n ?? 0,
    }),
  );
});

export default router;
