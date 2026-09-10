// The operator work queue (R126 split the single file into this shell, the
// case card with its escalation item, the morning brief, the layout pieces
// and the pure helpers). The route (App.tsx) and both suites keep importing
// "@/pages/operator-queue" / "./operator-queue": this module is the page's
// surface.

import { useState } from "react";
import {
  useGetMe,
  useListOperatorCases,
  useGetOperatorBrief,
  getGetOperatorBriefQueryKey,
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
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { SegmentedControl, WorkspaceHeader } from "@workspace/web-ui";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isForbidden, serverErrorToast } from "@/lib/errors";
import { humanize } from "@/lib/format";
import { Inbox } from "lucide-react";
import { CaseCard } from "./case-card";
import { OperatorBriefCard } from "./operator-brief-card";
import { OperatorAccessRequired, QueueHealthSection } from "./layout";

export function OperatorQueue() {
  usePageTitle("Operator queue");
  const [status, setStatus] = useState<ListOperatorCasesStatus>("open");
  const { data: me } = useGetMe();
  // Auditors hold operator.queue.read but not .act — the queue renders
  // read-only for them instead of offering buttons that 403.
  const canAct = (me?.capabilities ?? []).includes("operator.queue.act");
  // Daily brief (round-12 idea #1): "what needs me first" — operators only
  // (the route 403s auditors), pure SQL, renders only on success.
  const { data: brief } = useGetOperatorBrief({
    query: {
      queryKey: getGetOperatorBriefQueryKey(),
      enabled: canAct,
      staleTime: 5 * 60_000,
      retry: false,
    },
  });
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
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not claim case",
            fallback: "Try again.",
          }),
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
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not resolve case",
            fallback: "Try again.",
          }),
        onSettled: () => setPendingCaseId(null),
      },
    );
  };

  // The operator endpoints answer 403 unless the signed-in principal is an
  // operator. A firm_admin/firm_staff reaching this page should see a friendly
  // prompt instead of an infinite spinner or a crash.
  if (isForbidden(error) || isForbidden(statsError)) {
    return <OperatorAccessRequired />;
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Compliance Desk"
        title="Operator work queue"
        titleTestId="text-page-title"
        description="Cross-tenant cases with playbook prompts and one-click resolutions."
      />

      {brief && <OperatorBriefCard brief={brief} />}

      <SegmentedControl<ListOperatorCasesStatus>
        items={[
          { value: "open", label: "Open", count: stats?.openCount },
          {
            value: "in_progress",
            label: "In progress",
            count: stats?.inProgressCount,
          },
          { value: "resolved", label: "Resolved", count: stats?.resolvedCount },
        ]}
        value={status}
        onChange={setStatus}
        label="Case state"
        testIdPrefix="tab"
      />

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
          <EmptyState
            icon={Inbox}
            title={`No ${humanize(status).toLowerCase()} cases`}
            description="Cases land here when submissions fail or clients escalate — switch tabs to see other states."
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(data ?? []).map((c) => (
            <CaseCard
              key={c.id}
              c={c}
              onClaim={handleClaim}
              onResolve={handleResolve}
              onReplied={invalidate}
              claiming={claim.isPending && pendingCaseId === c.id}
              resolving={resolve.isPending && pendingCaseId === c.id}
              canAct={canAct}
            />
          ))}
        </div>
      )}

      <QueueHealthSection stats={stats} statsLoading={statsLoading} />
    </div>
  );
}

// The unit suite (operator-queue.test.ts) pins this through the page's
// module, so the split keeps the import path as its surface.
export { spendAlertsLine } from "./helpers";
