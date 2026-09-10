import type { OperatorBrief } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sunrise } from "lucide-react";
import { spendAlertsLine } from "./helpers";

// Daily brief (round-12 idea #1): "what needs me first" — operators only
// (the route 403s auditors), pure SQL, renders only on success.
export function OperatorBriefCard({ brief }: { brief: OperatorBrief }) {
  return (
    <Card data-testid="operator-brief">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <Sunrise aria-hidden="true" />
          </span>
          This morning
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {brief.openCases.oldestTitle && (
          <p className="text-muted-foreground" data-testid="brief-oldest-case">
            {brief.openCases.byPriority
              .map((p) => `${p.count} ${p.priority}`)
              .join(" · ")}{" "}
            open — longest waiting: “{brief.openCases.oldestTitle.slice(0, 80)}
            ”.
          </p>
        )}
        <p className="text-muted-foreground">
          {brief.unansweredEscalations.count > 0
            ? `${brief.unansweredEscalations.count} client escalation(s) await a reply — oldest: “${(brief.unansweredEscalations.oldestReason ?? "").slice(0, 80)}”.`
            : "No client escalations await a reply."}{" "}
          {brief.stuckBatches.count > 0
            ? `${brief.stuckBatches.count} batch(es) still queued or processing.`
            : ""}{" "}
          {brief.unmappedCodeCases > 0
            ? `${brief.unmappedCodeCases} unmapped rejection code(s) need catalogue entries.`
            : ""}{" "}
          {brief.decidedYesterday} case(s) were decided yesterday.
        </p>
        {(brief.approvalsPending > 0 || brief.unmatchedCollections7d > 0) && (
          <p className="text-muted-foreground" data-testid="brief-governance">
            {brief.approvalsPending > 0
              ? `${brief.approvalsPending} invoice(s) across policy-on firms await a colleague's submission approval.`
              : ""}{" "}
            {brief.unmatchedCollections7d > 0
              ? `${brief.unmatchedCollections7d} collection-account payment(s) this week matched no invoice.`
              : ""}
          </p>
        )}
        <p
          className={
            brief.spendAlerts > 0
              ? "font-medium text-amber-700 dark:text-amber-400"
              : "text-muted-foreground"
          }
          data-testid="brief-spend-alerts"
        >
          {spendAlertsLine(brief.spendAlerts)}
        </p>
        {(!brief.clerkEnabled || brief.resistanceAlert) && (
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            {!brief.clerkEnabled ? "Clerk AI is currently DISABLED. " : ""}
            {brief.resistanceAlert
              ? "Injection resistance dropped month-over-month — see Clerk health."
              : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
