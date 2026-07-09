import { useState } from "react";
import {
  useGetMe,
  useListOperatorCases,
  useGetOperatorQueueStats,
  useClaimOperatorCase,
  useResolveOperatorCase,
  getListOperatorCasesQueryKey,
  getGetOperatorQueueStatsQueryKey,
} from "@workspace/api-client-react";
import type {
  OperatorCaseView,
  ListOperatorCasesStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isForbidden } from "@/lib/errors";
import { humanize, priorityBadgeClasses } from "@/lib/format";
import { Clock, Zap, ShieldCheck, Lock, LifeBuoy, Inbox } from "lucide-react";

function formatDuration(seconds?: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function CaseCard({
  c,
  onClaim,
  onResolve,
  claiming,
  resolving,
  canAct,
}: {
  c: OperatorCaseView;
  onClaim: (c: OperatorCaseView) => void;
  onResolve: (c: OperatorCaseView, code: string, note: string) => void;
  claiming: boolean;
  resolving: boolean;
  canAct: boolean;
}) {
  const [note, setNote] = useState("");

  return (
    <Card data-testid={`card-case-${c.id}`}>
      <CardContent className="pt-6 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">{c.title}</p>
            <p className="text-xs text-muted-foreground">
              {c.firmName ?? "Firm"}
              {c.clientName ? ` · ${c.clientName}` : ""}
              {c.invoiceNumber ? ` · ${c.invoiceNumber}` : ""}
              {c.errorCode ? ` · ${c.errorCode}` : ""}
            </p>
          </div>
          <span className={`${priorityBadgeClasses(c.priority)} shrink-0`}>
            {humanize(c.priority)}
          </span>
        </div>

        {c.playbook && (
          <div className="rounded-md bg-muted/60 p-3 text-sm space-y-1">
            <p className="font-medium flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
              Playbook · {c.playbook.category}
            </p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Cause:</span>{" "}
              {c.playbook.cause}
            </p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Fix:</span>{" "}
              {c.playbook.fix}
            </p>
          </div>
        )}

        {(c.escalations ?? []).length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-sm space-y-1.5">
            <p className="font-medium flex items-center gap-1.5 text-amber-900 dark:text-amber-200">
              <LifeBuoy className="w-4 h-4" aria-hidden="true" /> Client
              escalation
            </p>
            {(c.escalations ?? []).map((e) => (
              <p key={e.id} className="text-amber-900/80 dark:text-amber-200/80">
                “{e.reason}”
              </p>
            ))}
          </div>
        )}

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Handle:{" "}
            {formatDuration(c.handleSeconds)}
          </span>
          <span>{humanize(c.status)}</span>
        </div>

        {c.status === "open" && canAct && (
          <Button
            size="sm"
            className="w-full"
            disabled={claiming}
            onClick={() => onClaim(c)}
            data-testid={`button-claim-${c.id}`}
          >
            {claiming ? "Claiming…" : "Claim case"}
          </Button>
        )}

        {c.status === "in_progress" && canAct && (
          <div className="space-y-2">
            <Label htmlFor={`note-${c.id}`} className="sr-only">
              Resolution note
            </Label>
            <Input
              id={`note-${c.id}`}
              placeholder="Resolution note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid={`input-note-${c.id}`}
            />
            <div className="flex gap-2">
              {c.playbook?.retriable && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  disabled={resolving}
                  onClick={() => onResolve(c, "retried", note)}
                  data-testid={`button-retry-${c.id}`}
                >
                  <Zap className="w-4 h-4 mr-1" aria-hidden="true" /> Retry &
                  resolve
                </Button>
              )}
              <Button
                size="sm"
                className="flex-1"
                disabled={resolving}
                onClick={() => onResolve(c, "resolved_manually", note)}
                data-testid={`button-resolve-${c.id}`}
              >
                {resolving ? "Resolving…" : "Resolve"}
              </Button>
            </div>
          </div>
        )}

        {c.status === "resolved" && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Resolved{c.resolutionCode ? ` · ${humanize(c.resolutionCode)}` : ""}
            {c.resolutionNote ? ` — ${c.resolutionNote}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  label,
  value,
  loading,
  "data-testid": testId,
}: {
  label: string;
  value: string;
  loading: boolean;
  "data-testid": string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        {loading ? (
          <Skeleton className="h-8 w-16 mt-1" />
        ) : (
          <p className="text-2xl font-bold mt-1 tabular-nums">{value}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function OperatorQueue() {
  usePageTitle("Operator queue");
  const [status, setStatus] = useState<ListOperatorCasesStatus>("open");
  const { data: me } = useGetMe();
  // Auditors hold operator.queue.read but not .act — the queue renders
  // read-only for them instead of offering buttons that 403.
  const canAct = (me?.capabilities ?? []).includes("operator.queue.act");
  const { data, isLoading, error, refetch } = useListOperatorCases({ status });
  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
  } = useGetOperatorQueueStats();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Per-case pending: only the card whose action fired disables (§7).
  const [pendingCaseId, setPendingCaseId] = useState<string | null>(null);

  const claim = useClaimOperatorCase();
  const resolve = useResolveOperatorCase();

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getListOperatorCasesQueryKey(),
    });
    queryClient.invalidateQueries({
      queryKey: getGetOperatorQueueStatsQueryKey(),
    });
  };

  const handleClaim = (c: OperatorCaseView) => {
    setPendingCaseId(c.id);
    claim.mutate(
      { id: c.id },
      {
        onSuccess: () => {
          toast({ title: "Case claimed" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not claim case", variant: "destructive" }),
        onSettled: () => setPendingCaseId(null),
      },
    );
  };

  const handleResolve = (c: OperatorCaseView, code: string, note: string) => {
    setPendingCaseId(c.id);
    resolve.mutate(
      { id: c.id, data: { resolutionCode: code, note: note || undefined } },
      {
        onSuccess: () => {
          toast({ title: "Case resolved" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not resolve case", variant: "destructive" }),
        onSettled: () => setPendingCaseId(null),
      },
    );
  };

  // The operator endpoints answer 403 unless the signed-in principal is an
  // operator. A firm_admin/firm_staff reaching this page should see a friendly
  // prompt instead of an infinite spinner or a crash.
  if (isForbidden(error) || isForbidden(statsError)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Operator work queue
        </h1>
        <Card data-testid="card-operator-access-required">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Lock
                className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium">Operator access required</p>
                <p className="text-sm text-muted-foreground mt-1">
                  This queue is for operator accounts. Sign in as an operator
                  from the portal at{" "}
                  <a href="/" className="underline" data-testid="link-portal">
                    /
                  </a>
                  .
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Operator work queue
        </h1>
        <p className="text-muted-foreground mt-1">
          Cross-tenant cases with playbook prompts and one-click resolutions.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <StatTile
          label="Open"
          value={String(stats?.openCount ?? "—")}
          loading={statsLoading}
          data-testid="stat-open"
        />
        <StatTile
          label="In progress"
          value={String(stats?.inProgressCount ?? "—")}
          loading={statsLoading}
          data-testid="stat-in-progress"
        />
        <StatTile
          label="Resolved"
          value={String(stats?.resolvedCount ?? "—")}
          loading={statsLoading}
          data-testid="stat-resolved"
        />
        <StatTile
          label="Clients served"
          value={String(stats?.clientsServed ?? "—")}
          loading={statsLoading}
          data-testid="stat-clients-served"
        />
        <StatTile
          label="Avg handle time"
          value={formatDuration(stats?.avgHandleSeconds)}
          loading={statsLoading}
          data-testid="stat-avg-handle"
        />
      </div>

      <Tabs
        value={status}
        onValueChange={(v) => setStatus(v as ListOperatorCasesStatus)}
      >
        <TabsList>
          <TabsTrigger value="open" data-testid="tab-open">
            Open
          </TabsTrigger>
          <TabsTrigger value="in_progress" data-testid="tab-in-progress">
            In progress
          </TabsTrigger>
          <TabsTrigger value="resolved" data-testid="tab-resolved">
            Resolved
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-56" />
          ))}
        </div>
      ) : error ? (
        <QueryError thing="the work queue" onRetry={() => refetch()} />
      ) : (data ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <Inbox
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-empty">
              No {humanize(status).toLowerCase()} cases
            </p>
            <p className="text-sm text-muted-foreground">
              Cases land here when submissions fail or clients escalate —
              switch tabs to see other states.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data ?? []).map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              onClaim={handleClaim}
              onResolve={handleResolve}
              claiming={claim.isPending && pendingCaseId === c.id}
              resolving={resolve.isPending && pendingCaseId === c.id}
              canAct={canAct}
            />
          ))}
        </div>
      )}
    </div>
  );
}
