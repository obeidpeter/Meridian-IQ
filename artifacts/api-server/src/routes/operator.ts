import { Router, type IRouter } from "express";
import { desc, inArray } from "drizzle-orm";
import {
  getDb,
  auditEventsTable,
  railStatesTable,
  type OutboxEvent,
  type Rail,
} from "@workspace/db";
import { pageBounds } from "../lib/page";
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
  GetReleaseReadinessResponse,
  ListDeadLettersQueryParams,
  ListRetryingEventsQueryParams,
  ListRetryingEventsResponse,
} from "@workspace/api-zod";
import { parseOrThrow } from "../lib/parse";
import { describeKeyRing, legacyTokenPathEnabled } from "../lib/op-token";
import { assertCan } from "../modules/auth/rbac";
import { railTransportSummary } from "../modules/rails/adapter";
import {
  listDeadLetters,
  listRetrying,
  replayDead,
  reconcile,
  SWEEP_PASS_ABANDONED_ACTION,
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
import { getReleaseReadiness } from "../modules/desk/release-readiness";

const router: IRouter = Router();

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

// Timestamps the contract types as nullable strings are serialised here:
// a row straight from the driver carries Date objects, which the response
// schema would refuse — during the one outage the card exists for.
function serialiseOutboxEvent(event: OutboxEvent) {
  return {
    ...event,
    nextAttemptAt: iso(event.nextAttemptAt),
    parkedUntil: iso(event.parkedUntil),
    firstAttemptAt: iso(event.firstAttemptAt),
  };
}

router.get("/operator/dead-letters", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const query = parseOrThrow(ListDeadLettersQueryParams, req.query);
  const bounds = pageBounds(query, { defaultLimit: 50, maxLimit: 200 });
  const page = await listDeadLetters({
    limit: bounds.limit,
    cursor: query.cursor,
  });
  res.json(
    ListDeadLettersResponse.parse({
      items: page.items.map(serialiseOutboxEvent),
      nextCursor: page.nextCursor,
    }),
  );
});

// What is still on its way (R102): pending events that have failed at least
// once or are parked behind a breaker, soonest retry first — the answer to
// "why has this invoice not stamped yet" before anything dead-letters.
router.get("/operator/retrying", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const query = parseOrThrow(ListRetryingEventsQueryParams, req.query);
  const bounds = pageBounds(query, { defaultLimit: 50, maxLimit: 200 });
  const page = await listRetrying({
    limit: bounds.limit,
    cursor: query.cursor,
  });
  res.json(
    ListRetryingEventsResponse.parse({
      items: page.items.map(serialiseOutboxEvent),
      nextCursor: page.nextCursor,
    }),
  );
});

router.get("/operator/release-readiness", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  res.json(GetReleaseReadinessResponse.parse(await getReleaseReadiness()));
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

// Breaker state per rail plus which transport is live (R95): the simulator
// until a RAIL_*_URL is lit, then the HTTP transport, which serves only the
// rails it has a URL for — an unserved rail shows `configured: false`.
// Both rails always appear: a breaker row is created lazily on a rail's
// first gate, so a rail the transport never touches (unserved, or nothing
// submitted yet) is synthesised as closed — the Desk must be able to say
// "not configured" before the first submission, not after.
const RAILS: readonly Rail[] = ["rail_primary", "rail_secondary"];

router.get("/operator/rails", async (req, res): Promise<void> => {
  assertCan(req.principal, "operator.queue.read");
  const rows = await getDb().select().from(railStatesTable);
  const byRail = new Map(rows.map((row) => [row.rail, row]));
  const summary = railTransportSummary();
  const now = new Date();
  res.json(
    ListRailStatesResponse.parse(
      RAILS.map((rail) => {
        const row = byRail.get(rail) ?? {
          rail,
          state: "closed" as const,
          failureCount: 0,
          openedAt: null,
          retryAt: null,
          probeStartedAt: null,
          lastErrorCode: null,
          updatedAt: now,
        };
        return {
          ...row,
          openedAt: iso(row.openedAt),
          retryAt: iso(row.retryAt),
          lastErrorCode: row.lastErrorCode ?? null,
          transport: summary.transport,
          environment: summary.environment,
          configured: summary.rails[rail].configured,
        };
      }),
    ),
  );
});

// The closed set of durable health-alert actions the Desk surfaces: the ops
// health watch's three conditions plus the clerk watch trio. Importing the
// constants (not re-typing the strings) keeps route and sweeps in lockstep.
const HEALTH_ALERT_ACTIONS = [
  RAIL_CIRCUIT_OPEN_ACTION,
  OUTBOX_DEAD_ACTION,
  WEBHOOK_DELIVERY_DEAD_ACTION,
  SWEEP_PASS_ABANDONED_ACTION,
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
// request, matching how every gate reads it. A token-governed rail (R100)
// also reports its key IDS — never a secret — so the operator can see which
// keys a provider may sign with and whether the pre-key-ring `legacy` single
// token is still accepted.
const RAIL_CONFIG_ENTRIES: {
  key: string;
  label: string;
  env: string;
  note: string;
  keyRing?: boolean;
}[] = [
  {
    key: "inbound_email",
    label: "Inbound email intake",
    env: "INBOUND_EMAIL_TOKEN",
    note: "Fail-closed: unset keeps the inbound email rail dark.",
    keyRing: true,
  },
  {
    key: "inbound_whatsapp",
    label: "Inbound WhatsApp intake",
    env: "INBOUND_WHATSAPP_TOKEN",
    note: "Fail-closed: unset keeps the inbound WhatsApp rail dark.",
    keyRing: true,
  },
  {
    key: "messaging_relay",
    label: "Outbound messaging relay",
    env: "MESSAGING_WEBHOOK_URL",
    note: "Unset keeps every send on the in-process simulator.",
  },
  {
    key: "invoice_room_encryption",
    label: "Invoice Room token encryption",
    env: "INVOICE_ROOM_ENCRYPTION_KEY",
    note: "Required in production before secure Invoice Room links can be created or opened.",
  },
  {
    key: "invoice_payment_provider",
    label: "Invoice Room payment provider",
    env: "INVOICE_PAYMENT_PROVIDER_URL",
    note: "Unset leaves hosted invoice checkout dark; bank-transfer instructions remain available.",
  },
  {
    key: "payment_provider",
    label: "Payment provider",
    env: "PAYMENT_PROVIDER_URL",
    note: "Unset keeps billing checkout on the simulated provider.",
  },
  {
    key: "rail_primary",
    label: "Access-point rail (primary)",
    env: "RAIL_PRIMARY_URL",
    note: "Unset keeps rail_primary on the in-process simulator; set the access point's base URL (and RAIL_PRIMARY_TOKEN) to go live.",
  },
  {
    key: "rail_secondary",
    label: "Access-point rail (secondary)",
    env: "RAIL_SECONDARY_URL",
    note: "Unset keeps rail_secondary on the simulator; failover needs both rails lit.",
  },
  {
    key: "payment_webhook",
    label: "Payment settlement webhook",
    env: "PAYMENT_WEBHOOK_TOKEN",
    note: "Fail-closed: unset means no settlement webhook exists at all.",
    keyRing: true,
  },
  {
    key: "invoice_payment_webhook",
    label: "Invoice Room payment webhook",
    env: "INVOICE_PAYMENT_WEBHOOK_TOKEN",
    note: "Fail-closed: unset means a hosted invoice payment cannot be confirmed by the provider.",
    keyRing: true,
  },
  {
    key: "collection_webhook",
    label: "Collection settlement webhook",
    env: "COLLECTION_WEBHOOK_TOKEN",
    note: "Fail-closed: unset means the inbound collection webhook does not exist.",
    keyRing: true,
  },
  {
    key: "metrics_token",
    label: "Metrics scrape token",
    env: "METRICS_TOKEN",
    note: "Required in production; non-production may leave /api/metrics open for local scraping.",
    keyRing: true,
  },
  {
    key: "sweep_token",
    label: "Sweep trigger token",
    env: "SWEEP_TOKEN",
    note: "Fail-closed: /api/internal/sweep answers 404 until this is set; the scheduler must sign or present it as x-op-token.",
    keyRing: true,
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
      RAIL_CONFIG_ENTRIES.map((entry) => {
        const ring = entry.keyRing ? describeKeyRing(entry.env) : null;
        return {
          key: entry.key,
          label: entry.label,
          configured: ring
            ? ring.configured
            : Boolean(process.env[entry.env]?.trim()),
          note: entry.note,
          keyIds: ring ? ring.keyIds : [],
          legacyTokenAccepted: ring ? legacyTokenPathEnabled() : false,
        };
      }),
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
