import {
  useGetAutomationRollup,
  getGetAutomationRollupQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Automation rollup (round 33): the firm's standing-automation posture in
// one read — live and paused policy counts for both kinds (pauses grouped
// by reason), what the plan runs did over 30 days, and how much of the
// decision ledger was automation-driven. Pure ledger SQL server-side. Lives
// on the PORTFOLIO page: the route gates on console.portfolio.read (a
// firm-internal aggregate — client_users must not see sibling pause
// reasons, and operators have no tenant to read), so this is the surface
// whose audience can actually fetch it. Render-on-success: any 4xx —
// older server build, wrong principal — shows nothing at all. Renders only
// when the firm has any automation footprint.
export function pausedSummary(paused: Record<string, number>): string | null {
  const entries = Object.entries(paused);
  if (entries.length === 0) return null;
  const total = entries.reduce((a, [, n]) => a + n, 0);
  const reasons = entries
    .map(([reason, n]) => `${reason.replace(/_/g, " ")} ${n}`)
    .join(", ");
  return `${total} paused (${reasons})`;
}

export function AutomationRollupCard() {
  const { data: rollup, isSuccess } = useGetAutomationRollup({
    query: { queryKey: getGetAutomationRollupQueryKey(), retry: false },
  });
  if (!isSuccess || !rollup) return null;
  const actionPaused = pausedSummary(rollup.actionPolicies.paused);
  const planPaused = pausedSummary(rollup.planPolicies.paused);
  const footprint =
    rollup.actionPolicies.live +
    rollup.planPolicies.live +
    (actionPaused ? 1 : 0) +
    (planPaused ? 1 : 0) +
    rollup.runs30d.total +
    rollup.decisions30d.total;
  if (footprint === 0) return null;
  return (
    <Card data-testid="card-automation-rollup">
      <CardHeader>
        <CardTitle className="text-base">Automation</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-md border p-3" data-testid="rollup-action-policies">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Daily action approvals
            </p>
            <p className="mt-1 text-sm tabular-nums">
              {rollup.actionPolicies.live} live
              {actionPaused ? <> · {actionPaused}</> : null}
            </p>
          </div>
          <div className="rounded-md border p-3" data-testid="rollup-plan-policies">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Monthly plan approvals
            </p>
            <p className="mt-1 text-sm tabular-nums">
              {rollup.planPolicies.live} live
              {planPaused ? <> · {planPaused}</> : null}
            </p>
          </div>
          <div className="rounded-md border p-3" data-testid="rollup-runs-30d">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Plan runs · 30 days
            </p>
            <p className="mt-1 text-sm tabular-nums">
              {rollup.runs30d.total} run{rollup.runs30d.total === 1 ? "" : "s"} ·{" "}
              {rollup.runs30d.done} done · {rollup.runs30d.halted} halted
            </p>
          </div>
          <div className="rounded-md border p-3" data-testid="rollup-decisions-30d">
            <p className="text-xs font-medium uppercase text-muted-foreground">
              Action batches · 30 days
            </p>
            <p className="mt-1 text-sm tabular-nums">
              {rollup.decisions30d.total} total · {rollup.decisions30d.auto}{" "}
              automated · {rollup.decisions30d.executed} executed ·{" "}
              {rollup.decisions30d.failed} failed
            </p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Every automated batch traces to a standing approval or an approved
          plan run in the decision ledger. Pauses are tripwires, not errors —
          daily approvals resume from the client&apos;s actions card; a
          monthly plan resumes from the surface that granted it.
        </p>
      </CardContent>
    </Card>
  );
}
