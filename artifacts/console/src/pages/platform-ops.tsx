import { useState } from "react";
import {
  useListDeadLetters,
  useReplayDeadLetter,
  useReconcilePipeline,
  useListRailStates,
  useListMessages,
  getListDeadLettersQueryKey,
  getListRailStatesQueryKey,
  getListMessagesQueryKey,
} from "@workspace/api-client-react";
import type { OutboxEvent, Message } from "@workspace/api-client-react";
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
  RefreshCw,
  RotateCcw,
  Inbox,
  MessageSquare,
} from "lucide-react";
import {
  formatDateTime,
  railBadgeClasses,
  railStateLabel,
  messageBadgeClasses,
  messageStatusLabel,
} from "@/lib/format";

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
                <div>
                  <p className="font-medium">{rail.rail}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {rail.failureCount} recent failure
                    {rail.failureCount === 1 ? "" : "s"}
                    {rail.openedAt
                      ? ` · opened ${formatDateTime(rail.openedAt)}`
                      : ""}
                  </p>
                </div>
                <span className={`${railBadgeClasses(rail.state)} shrink-0`}>
                  {railStateLabel(rail.state)}
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

      <RailsSection />
      <DeadLettersSection />
      <MessagesSection />
    </div>
  );
}
