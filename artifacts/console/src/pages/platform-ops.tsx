import {
  useListDeadLetters,
  useReplayDeadLetter,
  useReconcilePipeline,
  useListRailStates,
  getListDeadLettersQueryKey,
  getListRailStatesQueryKey,
} from "@workspace/api-client-react";
import type { OutboxEvent, RailState } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  RotateCcw,
  Inbox,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";

// Rail circuit-breaker states: closed = healthy, half_open = probing after a
// trip, open = failing fast until the cool-off elapses.
function railBadge(state: RailState["state"]): {
  cls: string;
  label: string;
} {
  switch (state) {
    case "open":
      return { cls: "bg-red-100 text-red-800 border-red-200", label: "Circuit open" };
    case "half_open":
      return { cls: "bg-amber-100 text-amber-800 border-amber-200", label: "Half-open (probing)" };
    default:
      return { cls: "bg-emerald-100 text-emerald-800 border-emerald-200", label: "Healthy" };
  }
}

function RailsSection() {
  const { data, isLoading } = useListRailStates();

  return (
    <Card data-testid="card-rails">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" /> Submission rails
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : (data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="text-rails-empty">
            No rail activity yet — states appear after the first submission.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {(data ?? []).map((rail) => {
              const badge = railBadge(rail.state);
              return (
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
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full border shrink-0 ${badge.cls}`}
                  >
                    {badge.label}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DeadLettersSection() {
  const { data, isLoading } = useListDeadLetters();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const replay = useReplayDeadLetter();

  const handleReplay = (event: OutboxEvent) => {
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
      },
    );
  };

  return (
    <Card data-testid="card-dead-letters">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="w-5 h-5 text-primary" /> Dead-lettered events
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : (data ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground flex items-center gap-2"
            data-testid="text-dead-letters-empty"
          >
            <CheckCircle2 className="w-4 h-4 text-emerald-600" />
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
                      <p className="text-xs text-red-700 mt-1 flex items-start gap-1">
                        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span className="break-all">{event.lastError}</span>
                      </p>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={replay.isPending}
                    onClick={() => handleReplay(event)}
                    data-testid={`button-replay-${event.id}`}
                  >
                    <RotateCcw className="w-4 h-4 mr-1" /> Replay
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

export function PlatformOps() {
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
          />
          Reconcile pipeline
        </Button>
      </div>

      <RailsSection />
      <DeadLettersSection />
    </div>
  );
}
