import { Link } from "wouter";
import type {
  ClientRisk,
  ComplianceDeadline,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { PenaltyRiskInfo } from "@/components/penalty-risk-info";
import {
  ArrowLeft,
  AlertTriangle,
  Archive,
  Download,
  CalendarClock,
  FileText,
  ShieldCheck,
  UserPlus,
  Pin,
} from "lucide-react";
import { humanize } from "@/lib/format";
import { Metric, MetricStrip } from "@workspace/web-ui";
import { canOffboardClient } from "./helpers";
import type { ClientDetailState } from "./use-client-detail";

// The one link the loaded page and its error state share.
export function BackToPortfolioLink() {
  return (
    <Link
      href="/portfolio?view=clients"
      className="inline-flex items-center gap-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
      data-testid="link-back"
    >
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to portfolio
    </Link>
  );
}

// Mirrors the loaded page: back link, header, then the two-column card grid.
export function ClientDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-40" />
      <div>
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-4 w-48 mt-2" />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-24" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function ClientDetailErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="space-y-6">
      <BackToPortfolioLink />
      <h1
        className="text-2xl md:text-3xl font-bold"
        data-testid="text-page-title"
      >
        Client details
      </h1>
      <QueryError thing="this client" onRetry={onRetry} />
    </div>
  );
}

export function ClientSummaryStrip({
  client,
  deadlines,
}: {
  client: ClientRisk;
  deadlines: ComplianceDeadline[];
}) {
  return (
    <MetricStrip label="Client summary">
      <Metric
        label="Invoices"
        value={String(client.totalInvoices)}
        detail="Recorded for this client"
        icon={<FileText className="size-4" aria-hidden="true" />}
      />
      <Metric
        label="Needs action"
        value={String(client.failingInvoiceIds.length)}
        detail="Failed or overdue submissions"
        icon={<AlertTriangle className="size-4" aria-hidden="true" />}
        tone={client.failingInvoiceIds.length > 0 ? "critical" : "default"}
      />
      <Metric
        label="Deadlines"
        value={String(deadlines.length)}
        detail="Upcoming and overdue statutory tasks"
        icon={<CalendarClock className="size-4" aria-hidden="true" />}
        tone={deadlines.length > 0 ? "warning" : "default"}
      />
      <Metric
        label="Penalty risk"
        value={humanize(client.penaltyRisk)}
        detail="Risk based on this client's records"
        icon={<ShieldCheck className="size-4" aria-hidden="true" />}
        tone={client.penaltyRisk === "high" ? "critical" : "default"}
        action={<PenaltyRiskInfo />}
      />
    </MetricStrip>
  );
}

// The header's actions: pin, invite (invitation.write), export and offboard
// (firm_admin). `client` is the shell's narrowed portfolio row.
export function ClientHeaderActions({
  state,
  client,
}: {
  state: ClientDetailState;
  client: ClientRisk;
}) {
  const { id, me, pinnedClients, exportQuery, handleExport, openOffboard } =
    state;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-pressed={pinnedClients.isPinned(id)}
        onClick={() =>
          pinnedClients.toggle({
            id,
            label: client.legalName,
            detail: `${humanize(client.penaltyRisk)} penalty risk`,
          })
        }
        data-testid="button-pin-client"
      >
        <Pin
          className={`w-4 h-4 mr-1 ${pinnedClients.isPinned(id) ? "fill-current" : ""}`}
          aria-hidden="true"
        />
        {pinnedClients.isPinned(id) ? "Pinned" : "Pin client"}
      </Button>
      {(me?.capabilities ?? []).includes("invitation.write") && (
        <Button asChild variant="outline">
          <Link
            href={`/invitations?role=client_user&clientPartyId=${encodeURIComponent(id)}`}
            data-testid="link-invite-client-user"
          >
            <UserPlus className="w-4 h-4 mr-1" aria-hidden="true" />
            Invite client user
          </Link>
        </Button>
      )}
      <Button
        variant="outline"
        onClick={handleExport}
        disabled={exportQuery.isFetching}
        data-testid="button-export-client-data"
      >
        <Download
          className={`w-4 h-4 mr-1 ${exportQuery.isFetching ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
        {exportQuery.isFetching ? "Exporting…" : "Export data"}
      </Button>
      {canOffboardClient(me?.role) && (
        <Button
          variant="destructive"
          onClick={openOffboard}
          data-testid="button-offboard-client"
        >
          <Archive className="w-4 h-4 mr-1" aria-hidden="true" />
          End client engagement
        </Button>
      )}
    </>
  );
}
