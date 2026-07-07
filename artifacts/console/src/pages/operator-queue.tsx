import { useMemo, useState } from "react";
import {
  useListOperatorCases,
  useClaimOperatorCase,
  useResolveOperatorCase,
  getListOperatorCasesQueryKey,
} from "@workspace/api-client-react";
import type {
  OperatorCaseView,
  ListOperatorCasesStatus,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Clock, Zap, ShieldCheck } from "lucide-react";

function formatDuration(seconds?: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function priorityBadge(p: OperatorCaseView["priority"]): string {
  switch (p) {
    case "high":
      return "bg-red-100 text-red-800 border-red-200";
    case "medium":
      return "bg-amber-100 text-amber-800 border-amber-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

function CaseCard({
  c,
  onClaim,
  onResolve,
  claiming,
  resolving,
}: {
  c: OperatorCaseView;
  onClaim: (c: OperatorCaseView) => void;
  onResolve: (c: OperatorCaseView, code: string, note: string) => void;
  claiming: boolean;
  resolving: boolean;
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
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full border shrink-0 ${priorityBadge(c.priority)}`}
          >
            {c.priority}
          </span>
        </div>

        {c.playbook && (
          <div className="rounded-md bg-muted/60 p-3 text-sm space-y-1">
            <p className="font-medium flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-primary" /> Playbook ·{" "}
              {c.playbook.category}
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

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" /> Handle:{" "}
            {formatDuration(c.handleSeconds)}
          </span>
          <span className="capitalize">{c.status.replace("_", " ")}</span>
        </div>

        {c.status === "open" && (
          <Button
            size="sm"
            className="w-full"
            disabled={claiming}
            onClick={() => onClaim(c)}
            data-testid={`button-claim-${c.id}`}
          >
            Claim case
          </Button>
        )}

        {c.status === "in_progress" && (
          <div className="space-y-2">
            <Input
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
                  <Zap className="w-4 h-4 mr-1" /> Retry & resolve
                </Button>
              )}
              <Button
                size="sm"
                className="flex-1"
                disabled={resolving}
                onClick={() => onResolve(c, "resolved_manually", note)}
                data-testid={`button-resolve-${c.id}`}
              >
                Resolve
              </Button>
            </div>
          </div>
        )}

        {c.status === "resolved" && (
          <p className="text-xs text-emerald-700">
            Resolved{c.resolutionCode ? ` · ${c.resolutionCode}` : ""}
            {c.resolutionNote ? ` — ${c.resolutionNote}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function OperatorQueue() {
  const [status, setStatus] = useState<ListOperatorCasesStatus>("open");
  const { data, isLoading } = useListOperatorCases({ status });
  const { data: allCases } = useListOperatorCases();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const claim = useClaimOperatorCase();
  const resolve = useResolveOperatorCase();

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListOperatorCasesQueryKey(),
    });

  const stats = useMemo(() => {
    const cases = allCases ?? [];
    const resolved = cases.filter(
      (c) => c.status === "resolved" && c.handleSeconds != null,
    );
    const avg =
      resolved.length > 0
        ? Math.round(
            resolved.reduce((s, c) => s + (c.handleSeconds ?? 0), 0) /
              resolved.length,
          )
        : null;
    return {
      open: cases.filter((c) => c.status === "open").length,
      inProgress: cases.filter((c) => c.status === "in_progress").length,
      resolved: resolved.length,
      avg,
    };
  }, [allCases]);

  const handleClaim = (c: OperatorCaseView) => {
    claim.mutate(
      { id: c.id },
      {
        onSuccess: () => {
          toast({ title: "Case claimed" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not claim case", variant: "destructive" }),
      },
    );
  };

  const handleResolve = (c: OperatorCaseView, code: string, note: string) => {
    resolve.mutate(
      { id: c.id, data: { resolutionCode: code, note: note || undefined } },
      {
        onSuccess: () => {
          toast({ title: "Case resolved" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not resolve case", variant: "destructive" }),
      },
    );
  };

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

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="stat-open">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Open</p>
            <p className="text-2xl font-bold mt-1">{stats.open}</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-in-progress">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">In progress</p>
            <p className="text-2xl font-bold mt-1">{stats.inProgress}</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-resolved">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Resolved</p>
            <p className="text-2xl font-bold mt-1">{stats.resolved}</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-avg-handle">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Avg handle time</p>
            <p className="text-2xl font-bold mt-1">
              {formatDuration(stats.avg)}
            </p>
          </CardContent>
        </Card>
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
      ) : (data ?? []).length === 0 ? (
        <p className="text-muted-foreground" data-testid="text-empty">
          No cases in this state.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data ?? []).map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              onClaim={handleClaim}
              onResolve={handleResolve}
              claiming={claim.isPending}
              resolving={resolve.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
