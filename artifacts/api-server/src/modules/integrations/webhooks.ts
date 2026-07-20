import { createHmac, randomBytes, createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  getDb,
  runInBypassContext,
  firmWebhooksTable,
  firmWebhookDeliveriesTable,
  type FirmWebhookRow,
  type FirmWebhookDeliveryRow,
} from "@workspace/db";
import { registerSweep } from "../pipeline/pipeline";
import { DomainError } from "../errors";
import { logger } from "../../lib/logger";

// Outbound firm webhooks (contract 0.41.0): a firm_admin registers an
// endpoint + event subscription; the platform fans domain events out into
// per-webhook delivery rows and a sweep-driven dispatcher POSTs them with
// outbox retry semantics. Payloads are POINTER-ONLY by design (SEC-12): an
// entity type + id the receiver resolves back through the authenticated API
// (e.g. with a firm API key) — never amounts, party names or document
// content, so a mis-registered or compromised receiver URL leaks nothing.

// The closed event catalog — derived from what the domain actually commits,
// not from aspiration:
// - invoice.stamped / invoice.settled ride the append-only
//   invoice_lifecycle_events ledger (recordTransition is the SINGLE writer
//   for every status transition — pipeline stamping, reconciliation
//   acceptance, bulk accept — so the fan-out can never miss an emit path or
//   disagree with the invoice's actual status history).
// - statement.reconciled rides the audit ledger's `statement.reconciled`
//   event (appended exactly once per completed reconcile pass in
//   modules/statements/service.ts, committed atomically with the proposals).
// Both sources are append-only and commit WITH the domain write, which makes
// this a post-commit fan-out by construction: a rolled-back stamp can never
// produce a delivery.
export const WEBHOOK_EVENTS = [
  "invoice.stamped",
  "invoice.settled",
  "statement.reconciled",
] as const;

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set(WEBHOOK_EVENTS);

// How far back the fan-out scans its source ledgers. The unique
// (webhook_id, event_key) index makes re-scans idempotent; the window merely
// bounds the scan (and every insert additionally requires the event to be
// newer than the webhook, so a new registration never receives history).
const FAN_OUT_WINDOW = "24 hours";

// Dispatch: outbox semantics (pipeline.ts precedent) — exponential backoff,
// dead after MAX_ATTEMPTS. The backoff is PRE-CHARGED at claim time (the
// claim bumps attempts and advances next_attempt_at before any network I/O),
// so a crashed instance mid-POST costs one counted attempt instead of a
// hot-loop, and a concurrent instance cannot double-send while the 5s HTTP
// call is in flight (the smallest backoff comfortably exceeds the timeout).
const MAX_DELIVERY_ATTEMPTS = 5;
const BASE_BACKOFF_SECONDS = 30;
const DELIVERY_TIMEOUT_MS = 5_000;
const CLAIM_BATCH = 10;
const LAST_ERROR_MAX = 300;

export const SIGNATURE_HEADER = "x-meridian-signature";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Delivery signing. Only the secret's sha256 is stored (shown-once posture),
// so the stored hash IS the HMAC key: signature =
// HMAC-SHA256(body, sha256hex(secret)), hex-encoded, in X-Meridian-Signature.
// The receiver derives the same key by hashing its stored secret once. This
// keeps the raw (possibly reused) secret unrecoverable platform-side while
// every delivery still authenticates; a DB leak could forge signatures — as
// with any stored signing key — but can never reveal the secret itself.
export function signDeliveryBody(secretHash: string, body: string): string {
  return createHmac("sha256", secretHash).update(body).digest("hex");
}

export function vetEvents(requested: string[]): string[] {
  const seen = new Set<string>();
  const vetted: string[] = [];
  for (const event of requested) {
    if (!WEBHOOK_EVENT_SET.has(event)) {
      throw new DomainError(
        "INVALID_EVENT",
        `Unknown webhook event ${event}; allowed: ${WEBHOOK_EVENTS.join(", ")}`,
        400,
      );
    }
    if (!seen.has(event)) {
      seen.add(event);
      vetted.push(event);
    }
  }
  return vetted;
}

// The delivery URL is TENANT-SUPPLIED, which makes the dispatcher an SSRF
// vector: in production require https and reject loopback/link-local/private
// literal hosts (DNS-level rebinding is out of scope here — pointer-only
// payloads bound the blast radius to "a POST arrived", and redirects are
// never followed). Outside production plain http/loopback is allowed so
// tests and local receivers work.
const PRIVATE_HOST_RE =
  /^(localhost|127\.(\d{1,3}\.){2}\d{1,3}|0\.0\.0\.0|10\.(\d{1,3}\.){2}\d{1,3}|192\.168\.(\d{1,3}\.)\d{1,3}|172\.(1[6-9]|2\d|3[01])\.(\d{1,3}\.)\d{1,3}|169\.254\.(\d{1,3}\.)\d{1,3}|\[?::1\]?)$/i;

export function vetWebhookUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainError("INVALID_URL", "Webhook URL must be a valid URL", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new DomainError(
      "INVALID_URL",
      "Webhook URL must use http(s)",
      400,
    );
  }
  if (process.env.NODE_ENV === "production") {
    if (url.protocol !== "https:") {
      throw new DomainError("INVALID_URL", "Webhook URL must use https", 400);
    }
    if (PRIVATE_HOST_RE.test(url.hostname)) {
      throw new DomainError(
        "INVALID_URL",
        "Webhook URL must resolve to a public host",
        400,
      );
    }
  }
  return url.toString();
}

export interface CreatedWebhook {
  row: FirmWebhookRow;
  secret: string;
}

// Register an endpoint. The signing secret (`whsec_<32 base64url chars>`) is
// shown ONCE; only its sha256 is stored (and doubles as the HMAC key — see
// signDeliveryBody). secret_prefix is the displayable identifier.
export async function createFirmWebhook(
  firmId: string,
  url: string,
  events: string[],
): Promise<CreatedWebhook> {
  const vettedUrl = vetWebhookUrl(url);
  const vettedEvents = vetEvents(events);
  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const [row] = await getDb()
    .insert(firmWebhooksTable)
    .values({
      firmId,
      url: vettedUrl,
      events: vettedEvents,
      secretHash: sha256Hex(secret),
      secretPrefix: secret.slice(0, 12),
    })
    .returning();
  return { row, secret };
}

export async function listFirmWebhooks(
  firmId: string,
): Promise<FirmWebhookRow[]> {
  return getDb()
    .select()
    .from(firmWebhooksTable)
    .where(eq(firmWebhooksTable.firmId, firmId))
    .orderBy(desc(firmWebhooksTable.createdAt));
}

// Disable: compare-and-set on `active` — deliveries stop (both fan-out and
// the dispatcher key on active), history is retained. Disabling an
// already-disabled webhook returns the row unchanged (idempotent); an id
// outside the firm is a 404.
export async function disableFirmWebhook(
  firmId: string,
  webhookId: string,
): Promise<FirmWebhookRow> {
  const [disabled] = await getDb()
    .update(firmWebhooksTable)
    .set({ active: false })
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
        eq(firmWebhooksTable.active, true),
      ),
    )
    .returning();
  if (disabled) return disabled;
  const [existing] = await getDb()
    .select()
    .from(firmWebhooksTable)
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!existing) throw new DomainError("NOT_FOUND", "Webhook not found", 404);
  return existing;
}

// Delivery history for one webhook, newest first. The webhook itself must be
// the firm's (404 otherwise); capped — this is an operational tail, not an
// export surface.
const DELIVERY_LIST_CAP = 200;

export async function listWebhookDeliveries(
  firmId: string,
  webhookId: string,
): Promise<FirmWebhookDeliveryRow[]> {
  const [webhook] = await getDb()
    .select({ id: firmWebhooksTable.id })
    .from(firmWebhooksTable)
    .where(
      and(
        eq(firmWebhooksTable.id, webhookId),
        eq(firmWebhooksTable.firmId, firmId),
      ),
    )
    .limit(1);
  if (!webhook) throw new DomainError("NOT_FOUND", "Webhook not found", 404);
  return getDb()
    .select()
    .from(firmWebhookDeliveriesTable)
    .where(eq(firmWebhookDeliveriesTable.webhookId, webhookId))
    .orderBy(desc(firmWebhookDeliveriesTable.createdAt))
    .limit(DELIVERY_LIST_CAP);
}

function rowsOf<T>(result: unknown): T[] {
  return (
    (result as { rows?: T[] }).rows ?? (result as T[])
  );
}

// Fan domain events out into delivery rows. Set-based INSERT..SELECT per
// source ledger; the unique (webhook_id, event_key) index + ON CONFLICT DO
// NOTHING makes concurrent sweep instances (and every re-scan of the
// trailing window) idempotent. Each insert requires the event to be newer
// than the webhook (`created_at >= w.created_at`) so a fresh registration
// starts from "now", never from history. Early-exits before touching the
// ledgers when no firm has an active webhook — the common case must cost one
// cheap probe.
export async function fanOutWebhookEvents(): Promise<number> {
  return runInBypassContext(async () => {
    const active = rowsOf<{ n: number }>(
      await getDb().execute(
        sql`SELECT count(*)::int AS n FROM firm_webhooks WHERE active`,
      ),
    );
    if (!active[0] || Number(active[0].n) === 0) return 0;

    let inserted = 0;

    // invoice.stamped / invoice.settled from the lifecycle ledger. Payload is
    // pointer-only (SEC-12): entity type + id, nothing else.
    const invoiceRes = rowsOf<{ id: string }>(
      await getDb().execute(sql`
        INSERT INTO firm_webhook_deliveries
          (webhook_id, firm_id, event_type, event_key, payload, status)
        SELECT
          w.id,
          w.firm_id,
          CASE e.to_status WHEN 'stamped' THEN 'invoice.stamped' ELSE 'invoice.settled' END,
          'lce:' || e.id,
          jsonb_build_object('entityType', 'invoice', 'entityId', e.invoice_id),
          'pending'
        FROM invoice_lifecycle_events e
        JOIN firm_webhooks w
          ON w.firm_id = e.firm_id
         AND w.active
         AND w.events ? (CASE e.to_status WHEN 'stamped' THEN 'invoice.stamped' ELSE 'invoice.settled' END)
        WHERE e.to_status IN ('stamped', 'settled')
          AND e.created_at >= now() - interval '${sql.raw(FAN_OUT_WINDOW)}'
          AND e.created_at >= w.created_at
        ON CONFLICT (webhook_id, event_key) DO NOTHING
        RETURNING id
      `),
    );
    inserted += invoiceRes.length;

    // statement.reconciled from the audit ledger (audit_events.firm_id is
    // text; compare on the webhook side cast so a malformed historical value
    // can never abort the sweep).
    const statementRes = rowsOf<{ id: string }>(
      await getDb().execute(sql`
        INSERT INTO firm_webhook_deliveries
          (webhook_id, firm_id, event_type, event_key, payload, status)
        SELECT
          w.id,
          w.firm_id,
          'statement.reconciled',
          'aud:' || a.seq,
          jsonb_build_object('entityType', 'bank_statement', 'entityId', a.entity_id),
          'pending'
        FROM audit_events a
        JOIN firm_webhooks w
          ON w.firm_id::text = a.firm_id
         AND w.active
         AND w.events ? 'statement.reconciled'
        WHERE a.action = 'statement.reconciled'
          AND a.created_at >= now() - interval '${sql.raw(FAN_OUT_WINDOW)}'
          AND a.created_at >= w.created_at
        ON CONFLICT (webhook_id, event_key) DO NOTHING
        RETURNING id
      `),
    );
    inserted += statementRes.length;

    return inserted;
  });
}

interface ClaimedDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
  url: string;
  secret_hash: string;
}

// Claim a batch of due deliveries: bump attempts and advance next_attempt_at
// (pre-charged backoff) in one committed statement BEFORE any network I/O —
// FOR UPDATE SKIP LOCKED keeps concurrent instances off the same rows, and
// only active webhooks' deliveries are ever claimed (disable stops the queue
// mid-flight, rows simply stay pending history).
async function claimDeliveries(): Promise<ClaimedDelivery[]> {
  return runInBypassContext(async () =>
    rowsOf<ClaimedDelivery>(
      await getDb().execute(sql`
        UPDATE firm_webhook_deliveries d
        SET attempts = d.attempts + 1,
            next_attempt_at = now()
              + (interval '${sql.raw(String(BASE_BACKOFF_SECONDS))} seconds' * power(2, d.attempts))
        FROM firm_webhooks w
        WHERE d.id IN (
          SELECT d2.id
          FROM firm_webhook_deliveries d2
          JOIN firm_webhooks w2 ON w2.id = d2.webhook_id AND w2.active
          WHERE d2.status IN ('pending', 'failed')
            AND d2.next_attempt_at <= now()
          ORDER BY d2.created_at ASC
          LIMIT ${CLAIM_BATCH}
          FOR UPDATE OF d2 SKIP LOCKED
        )
        AND w.id = d.webhook_id
        RETURNING d.id, d.webhook_id, d.event_type, d.payload, d.attempts,
                  d.created_at, w.url, w.secret_hash
      `),
    ),
  );
}

async function recordOutcome(
  delivery: ClaimedDelivery,
  ok: boolean,
  error: string | null,
): Promise<void> {
  await runInBypassContext(async () => {
    if (ok) {
      await getDb()
        .update(firmWebhookDeliveriesTable)
        .set({ status: "delivered", deliveredAt: new Date(), lastError: null })
        .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
      return;
    }
    const dead = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
    await getDb()
      .update(firmWebhookDeliveriesTable)
      .set({
        status: dead ? "dead" : "failed",
        lastError: (error ?? "delivery failed").slice(0, LAST_ERROR_MAX),
      })
      .where(eq(firmWebhookDeliveriesTable.id, delivery.id));
  });
}

// POST one claimed delivery. The body repeats the pointer-only payload plus
// delivery identity; the response BODY is never read or stored (only the
// status), so a webhook target cannot use lastError as an exfiltration or
// probe channel. Redirects are not followed (SSRF: a public URL must not
// bounce the POST somewhere private).
async function postDelivery(delivery: ClaimedDelivery): Promise<{
  ok: boolean;
  error: string | null;
}> {
  const body = JSON.stringify({
    id: delivery.id,
    eventType: delivery.event_type,
    entityType: delivery.payload.entityType ?? null,
    entityId: delivery.payload.entityId ?? null,
    createdAt: new Date(delivery.created_at).toISOString(),
  });
  try {
    const res = await fetch(delivery.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signDeliveryBody(delivery.secret_hash, body),
        "x-meridian-event": delivery.event_type,
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (res.ok) return { ok: true, error: null };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Drain due deliveries. Claim (committed) → POST (no transaction held across
// the network call) → record outcome (own transaction) — the pipeline
// worker's posture for slow external I/O. Bounded per pass; the sweep runs
// every minute, and the claim's ORDER BY keeps it fair.
export async function dispatchWebhookDeliveries(): Promise<number> {
  const claimed = await claimDeliveries();
  for (const delivery of claimed) {
    const { ok, error } = await postDelivery(delivery);
    await recordOutcome(delivery, ok, error);
    if (!ok) {
      logger.warn(
        { deliveryId: delivery.id, attempts: delivery.attempts, error },
        "webhook delivery failed",
      );
    }
  }
  return claimed.length;
}

// Registered with the pipeline worker at import time (routes/integrations.ts
// imports this module), like the other feature sweeps. Both halves are
// idempotent/claim-guarded, so multi-instance passes are safe no-ops.
registerSweep(async () => {
  await fanOutWebhookEvents();
  await dispatchWebhookDeliveries();
});
