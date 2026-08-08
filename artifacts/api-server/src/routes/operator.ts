import { Router, type IRouter } from "express";
import { desc, inArray } from "drizzle-orm";
import { getDb, auditEventsTable, railStatesTable } from "@workspace/db";
import {
  GetClerkAssuranceResponse,
  GetComplianceOperationsResponse,
  GetEvidenceVaultResponse,
  GetIntegrationReliabilityResponse,
  ListBuyerPilotsResponse,
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
import { RECONCILE_AGREEMENT_DROP_ACTION } from "../modules/clerk/agreement-watch";
import { getActivationMetrics } from "../modules/desk/activation";
import { getBuyerPilotWorkspace } from "../modules/buyer/pilots";
import { getComplianceOperationsWorkspace } from "../modules/desk/compliance-operations";
import { getIntegrationReliabilityWorkspace } from "../modules/desk/integration-reliability";
import { getEvidenceVaultWorkspace } from "../modules/audit/evidence-vault";
import { getClerkAssuranceWorkspace } from "../modules/clerk/assurance";

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
  RECONCILE_AGREEMENT_DROP_ACTION,
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
  res.json(GetGateMetricsResponse.parse(await getActivationMetrics()));
});

router.get("/operator/buyer-pilots", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(ListBuyerPilotsResponse.parse(await getBuyerPilotWorkspace()));
});

router.get(
  "/operator/compliance-operations",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.read");
    res.json(
      GetComplianceOperationsResponse.parse(
        await getComplianceOperationsWorkspace(),
      ),
    );
  },
);

router.get(
  "/operator/integration-reliability",
  async (req, res): Promise<void> => {
    assertCan(req.principal, "operator.queue.read");
    res.json(
      GetIntegrationReliabilityResponse.parse(
        await getIntegrationReliabilityWorkspace(),
      ),
    );
  },
);

router.get("/operator/evidence-vault", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(GetEvidenceVaultResponse.parse(await getEvidenceVaultWorkspace()));
});

router.get("/operator/clerk-assurance", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(GetClerkAssuranceResponse.parse(await getClerkAssuranceWorkspace()));
});

export default router;
