import { useState } from "react";
import {
  useListDeadLetters,
  useListRetryingEvents,
  useReplayDeadLetter,
  useReconcilePipeline,
  useListRailStates,
  useListMessages,
  useListHealthAlerts,
  useGetRailConfig,
  getListDeadLettersQueryKey,
  getListRailStatesQueryKey,
  getListMessagesQueryKey,
} from "@workspace/api-client-react";
import type {
  OutboxEvent,
  Message,
  HealthAlert,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isFeatureDisabled } from "@/lib/errors";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  BellRing,
  Plug,
  RefreshCw,
  RotateCcw,
  Inbox,
  MessageSquare,
} from "lucide-react";
import {
  formatDateTime,
  humanize,
  pillClasses,
  relativeTime,
  railBadgeClasses,
  railStateLabel,
  messageBadgeClasses,
  messageStatusLabel,
} from "@/lib/format";

// ---- Health-alert vocabulary -------------------------------------------------
// Humanized labels for the durable platform-health alerts the sweeps write to
// the audit ledger. A MIRROR of the known alert actions server-side — an
// action from a newer build degrades to humanize(), never to a blank row.
export const HEALTH_ALERT_ACTION_LABELS: Record<string, string> = {
  "ops.rail.circuit_open": "Rail circuit open",
  "ops.outbox.dead": "Dead-lettered event",
  "ops.webhook.delivery_dead": "Webhook delivery dead",
  "clerk.spend.anomaly": "Firm spend anomaly",
  "clerk.quality.drop": "Extraction quality drop",
  "clerk.injection_resistance.dropped": "Injection resistance drop",
};

export function healthAlertLabel(action: string): string {
  return HEALTH_ALERT_ACTION_LABELS[action] ?? humanize(action);
}

/** The "what tripped it" pointer: entity type · entity id. */
export function healthAlertEntityRef(
  alert: Pick<HealthAlert, "entityType" | "entityId">,
): string {
  return `${alert.entityType} · ${alert.entityId}`;
}

export const HEALTH_ALERTS_EMPTY = "No health alerts — the platform is quiet.";

// ---- Rail configuration (presence only) --------------------------------------
// The endpoint answers booleans only — never values — so the card can say
// which rails are lit without ever holding a secret client-side.
export const RAIL_CONFIG_INTRO =
  "Which environment-lit rails this deployment has configured. Values are never shown.";

export function railConfiguredLabel(configured: boolean): string {
  return configured ? "Configured" : "Dark";
}

export function railConfiguredBadgeClasses(configured: boolean): string {
  return pillClasses(configured ? "emerald" : "slate");
}

// Key IDS only (R100) — the endpoint never returns a secret. `legacy` is the
// pre-key-ring single token; naming it keeps a migration visible.
export function railKeyIdsLine(entry: {
  keyIds?: string[];
  legacyTokenAccepted?: boolean;
}): string | null {
  const ids = entry.keyIds ?? [];
  if (ids.length === 0) return null;
  const ring = ids.map((id) => (id === "legacy" ? "legacy (single token)" : id));
  const plain = entry.legacyTokenAccepted
    ? "plain x-op-token accepted"
    : "signed requests only";
  return `Keys: ${ring.join(", ")} — ${plain}`;
}

// ---- Rail transport (R95) ----------------------------------------------------
// Every rail row names the transport serving it and the provenance every
// stamp will carry: "simulator · sandbox" until a RAIL_*_URL is lit, then
// "http · sandbox" or "http · live". An HTTP transport serves only the rails
// it has a URL for, so an unserved rail says so in the line AND wears a
// neutral pill in place of its breaker badge — a closed breaker on a rail the
// transport never touches must not read as "ready to stamp".
export const RAIL_NOT_CONFIGURED_LABEL = "Not configured";

export function railTransportLine(rail: {
  transport: string;
  environment: string;
  configured: boolean;
}): string {
  const line = `${rail.transport} · ${rail.environment}`;
  return rail.configured ? line : `${line} · not configured`;
}

export function railNotConfiguredBadgeClasses(): string {
  return pillClasses("slate");
}

// The failure class the breaker last counted (R102): a refused credential
// reads differently from an outage, so the card says which.
export function railLastErrorLine(code: string): string {
  return code === "RAIL_UNAUTHORIZED"
    ? "last error RAIL_UNAUTHORIZED · the access point refuses our token"
    : `last error ${code}`;
}

// ---- Retrying events (R102) --------------------------------------------------
// Pending outbox rows that have already failed at least once, or are parked
// behind a rail breaker: the answer to "why has this not stamped yet" BEFORE
// anything dead-letters. One line per row, in the words the manual uses.
export function isParked(
  event: Pick<OutboxEvent, "parkedUntil">,
  now: Date = new Date(),
): boolean {
  return Boolean(event.parkedUntil && new Date(event.parkedUntil).getTime() > now.getTime());
}

export function retryingLine(
  event: Pick<OutboxEvent, "attempts" | "maxAttempts" | "nextAttemptAt" | "parkedUntil" | "parkCount">,
  now: Date = new Date(),
): string {
  const tries = `${event.attempts}/${event.maxAttempts} attempts`;
  if (isParked(event, now)) {
    const parks = event.parkCount ?? 0;
    return `${tries} · parked behind the rail breaker (${parks} park${parks === 1 ? "" : "s"}) · wakes ${formatDateTime(event.parkedUntil as string)}`;
  }
  return event.nextAttemptAt
    ? `${tries} · next try ${formatDateTime(event.nextAttemptAt)}`
    : tries;
}

export const RETRYING_EMPTY = "Nothing retrying — every queued event delivered or is waiting for its first try.";

function RetryingSection() {
  const { data, isLoading, error, refetch } = useListRetryingEvents({ limit: 50 });
  return (
    <Card data-testid="card-retrying">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
          Retrying events
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          <QueryError thing="retrying events" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground flex items-center gap-2"
            data-testid="text-retrying-empty"
          >
            <CheckCircle2
              className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            {RETRYING_EMPTY}
          </p>
        ) : (
          <div className="space-y-3">
            {(data ?? []).map((event) => (
              <div
                key={event.id}
                className="border rounded-md p-3"
                data-testid={`retrying-${event.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{event.type}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {event.aggregateType} · {event.aggregateId}
                    </p>
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid={`retrying-line-${event.id}`}
                    >
                      {retryingLine(event)}
                    </p>
                    {event.lastError && (
                      <p className="text-xs text-amber-700 dark:text-amber-400 mt-1 flex items-start gap-1">
                        <AlertTriangle
                          className="w-3.5 h-3.5 mt-0.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="break-all">{event.lastError}</span>
                      </p>
                    )}
                  </div>
                  {isParked(event) ? (
                    <span
                      className={`${pillClasses("amber")} shrink-0`}
                      data-testid={`retrying-parked-${event.id}`}
                    >
                      Parked
                    </span>
                  ) : (
                    <span className={`${pillClasses("slate")} shrink-0`}>Retrying</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RailsSection() {
  const { data, isLoading, error, refetch } = useListRailStates();

  return (
    <Card data-testid="card-rails">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
          Submission rails
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="rail states" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-rails-empty">
            No rail activity yet — states appear after the first submission.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(data ?? []).map((rail) => (
              <div
                key={rail.rail}
                className="border rounded-md p-3 flex items-start justify-between gap-3"
                data-testid={`rail-${rail.rail}`}
              >
                <div className="min-w-0">
                  <p className="font-medium">{rail.rail}</p>
                  <p
                    className="text-xs text-muted-foreground font-mono mt-0.5"
                    data-testid={`rail-transport-${rail.rail}`}
                  >
                    {railTransportLine(rail)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {rail.failureCount} recent failure
                    {rail.failureCount === 1 ? "" : "s"}
                    {rail.openedAt
                      ? ` · opened ${formatDateTime(rail.openedAt)}`
                      : ""}
                    {rail.state !== "closed" && rail.retryAt
                      ? ` · next probe ${formatDateTime(rail.retryAt)}`
                      : ""}
                  </p>
                  {rail.lastErrorCode ? (
                    <p
                      className="text-xs text-red-700 dark:text-red-400 mt-0.5 font-mono"
                      data-testid={`rail-last-error-${rail.rail}`}
                    >
                      {railLastErrorLine(rail.lastErrorCode)}
                    </p>
                  ) : null}
                </div>
                {rail.configured ? (
                  <span className={`${railBadgeClasses(rail.state)} shrink-0`}>
                    {railStateLabel(rail.state)}
                  </span>
                ) : (
                  <span
                    className={`${railNotConfiguredBadgeClasses()} shrink-0`}
                    data-testid={`rail-not-configured-${rail.rail}`}
                  >
                    {RAIL_NOT_CONFIGURED_LABEL}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Durable platform-health alerts (audit-ledger feed, newest first): the
// "what needs an operator" digest of circuit trips, dead letters, dead
// webhook deliveries and Clerk anomaly detectors.
function HealthAlertsSection() {
  const { data, isLoading, error, refetch } = useListHealthAlerts();

  return (
    <Card data-testid="card-health-alerts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
          Health alerts
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          // A failed fetch must never read as "all quiet".
          <QueryError thing="health alerts" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground flex items-center gap-2"
            data-testid="text-health-alerts-empty"
          >
            <CheckCircle2
              className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            {HEALTH_ALERTS_EMPTY}
          </p>
        ) : (
          <div className="divide-y">
            {(data ?? []).map((alert) => (
              <div
                key={alert.seq}
                className="py-2.5 flex items-center justify-between gap-3"
                data-testid={`health-alert-${alert.seq}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {healthAlertLabel(alert.action)}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {healthAlertEntityRef(alert)}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {relativeTime(alert.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Which env-lit rails this deployment has configured — presence booleans
// only, so a fail-closed rail (token unset → dark) is visible at a glance
// without the endpoint ever returning a value. The access-point rails
// (RAIL_PRIMARY_URL / RAIL_SECONDARY_URL, R95) arrive from the same
// endpoint: "Dark" there means the rail stays on the in-process simulator,
// and the entry's note says so.
function RailConfigSection() {
  const { data, isLoading, error, refetch } = useGetRailConfig();

  return (
    <Card data-testid="card-rail-config">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="w-5 h-5 text-primary" aria-hidden="true" /> Rail
          configuration
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">{RAIL_CONFIG_INTRO}</p>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="rail configuration" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-rail-config-empty"
          >
            No rails registered on this build.
          </p>
        ) : (
          <div className="divide-y">
            {(data ?? []).map((entry) => (
              <div
                key={entry.key}
                className="py-2.5 flex items-center justify-between gap-3"
                data-testid={`rail-config-${entry.key}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{entry.label}</p>
                  <p className="text-xs text-muted-foreground">{entry.note}</p>
                  {railKeyIdsLine(entry) && (
                    <p
                      className="text-xs text-muted-foreground font-mono mt-0.5"
                      data-testid={`rail-config-keys-${entry.key}`}
                    >
                      {railKeyIdsLine(entry)}
                    </p>
                  )}
                </div>
                <span
                  className={`${railConfiguredBadgeClasses(entry.configured)} shrink-0`}
                >
                  {railConfiguredLabel(entry.configured)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeadLettersSection() {
  const { data, isLoading, error, refetch } = useListDeadLetters();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const replay = useReplayDeadLetter();
  // Only the row whose Replay fired disables (§7).
  const [replayingId, setReplayingId] = useState<string | null>(null);

  const handleReplay = (event: OutboxEvent) => {
    setReplayingId(event.id);
    replay.mutate(
      { id: event.id },
      {
        onSuccess: () => {
          toast({ title: "Event requeued for delivery" });
          queryClient.invalidateQueries({
            queryKey: getListDeadLettersQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Could not replay event", variant: "destructive" }),
        onSettled: () => setReplayingId(null),
      },
    );
  };

  return (
    <Card data-testid="card-dead-letters">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
          Dead-lettered events
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : error ? (
          // A failed fetch must never read as "all delivered".
          <QueryError thing="dead-lettered events" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground flex items-center gap-2"
            data-testid="text-dead-letters-empty"
          >
            <CheckCircle2
              className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            Nothing dead-lettered — every queued event delivered.
          </p>
        ) : (
          <div className="space-y-3">
            {(data ?? []).map((event) => (
              <div
                key={event.id}
                className="border rounded-md p-3"
                data-testid={`dead-letter-${event.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-sm">{event.type}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {event.aggregateType} · {event.aggregateId}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {event.attempts}/{event.maxAttempts} attempts ·{" "}
                      {formatDateTime(event.createdAt)}
                    </p>
                    {event.lastError && (
                      <p className="text-xs text-red-700 dark:text-red-400 mt-1 flex items-start gap-1">
                        <AlertTriangle
                          className="w-3.5 h-3.5 mt-0.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="break-all">{event.lastError}</span>
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={replayingId === event.id}
                    onClick={() => handleReplay(event)}
                    data-testid={`button-replay-${event.id}`}
                  >
                    <RotateCcw
                      className={`w-4 h-4 mr-1 ${replayingId === event.id ? "animate-spin" : ""}`}
                      aria-hidden="true"
                    />
                    {replayingId === event.id ? "Replaying…" : "Replay"}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// PL-04 delivery visibility: pointer-only message rows (SEC-12) with their
// delivery status. 404 while messaging_notifications is dark.
function MessagesSection() {
  const { data, isLoading, error, refetch } = useListMessages({
    query: { queryKey: getListMessagesQueryKey(), retry: false },
  });

  return (
    <Card data-testid="card-messages">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" aria-hidden="true" />{" "}
          Message deliveries
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isFeatureDisabled(error) ? (
          <p className="text-sm text-muted-foreground" data-testid="text-messages-dark">
            Notifications ship dark (`messaging_notifications`). Flip the flag
            on the Feature flags page to start sending — deliveries appear here.
          </p>
        ) : isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="message deliveries" onRetry={() => refetch()} />
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-messages-empty">
            No messages sent yet.
          </p>
        ) : (
          <div className="divide-y">
            {(data ?? []).map((m: Message) => (
              <div
                key={m.id}
                className="py-2.5 flex items-center justify-between gap-3"
                data-testid={`message-${m.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {m.templateKey}
                    <span className="text-muted-foreground font-normal">
                      {" "}
                      · {m.channel}
                      {m.failoverFrom ? ` (failover from ${m.failoverFrom})` : ""}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDateTime(m.createdAt)}
                  </p>
                </div>
                <span className={`${messageBadgeClasses(m.status)} shrink-0`}>
                  {messageStatusLabel(m.status)}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function PlatformOps() {
  usePageTitle("Platform ops");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const reconcile = useReconcilePipeline();

  const handleReconcile = () => {
    reconcile.mutate(undefined, {
      onSuccess: (result) => {
        toast({
          title:
            result.requeued === 0
              ? "Pipeline clean — nothing stuck"
              : `Requeued ${result.requeued} stuck event${result.requeued === 1 ? "" : "s"}`,
        });
        queryClient.invalidateQueries({
          queryKey: getListDeadLettersQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListRailStatesQueryKey(),
        });
      },
      onError: () =>
        toast({ title: "Reconcile failed", variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Platform operations
          </h1>
          <p className="text-muted-foreground mt-1">
            Rail health, the transactional outbox and dead-letter replay.
          </p>
        </div>
        <Button
          onClick={handleReconcile}
          disabled={reconcile.isPending}
          data-testid="button-reconcile"
        >
          <RefreshCw
            className={`w-4 h-4 mr-1 ${reconcile.isPending ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
          {reconcile.isPending ? "Reconciling…" : "Reconcile pipeline"}
        </Button>
      </div>

      <HealthAlertsSection />
      <RailsSection />
      <RetryingSection />
      <RailConfigSection />
      <DeadLettersSection />
      <MessagesSection />
    </div>
  );
}
