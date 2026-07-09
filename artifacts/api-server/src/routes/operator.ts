import { Router, type IRouter } from "express";
import { eq, sql } from "drizzle-orm";
import {
  getDb,
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
} from "@workspace/api-zod";
import { assertCan } from "../modules/auth/rbac";
import {
  listDeadLetters,
  replayDead,
  reconcile,
} from "../modules/pipeline/pipeline";

const router: IRouter = Router();

router.get("/operator/dead-letters", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(ListDeadLettersResponse.parse(await listDeadLetters()));
});

router.post(
  "/operator/dead-letters/:id/replay",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.act");
    const params = ReplayDeadLetterParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    await replayDead(params.data.id);
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
