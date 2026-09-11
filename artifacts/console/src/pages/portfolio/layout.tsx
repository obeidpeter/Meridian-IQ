import { type ReactNode } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Plus,
  Upload,
  GitBranch,
  AlertTriangle,
  Users,
  FileWarning,
  Clock,
} from "lucide-react";
import type { PortfolioSummary } from "@workspace/api-client-react";
import { formatNaira } from "@/lib/format";
import { Metric, MetricStrip, WorkspaceHeader } from "@workspace/web-ui";

// A labeled group of cards. scroll-mt keeps an anchor-jumped heading clear of
// the sticky console header.
export function PortfolioSection({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={label}
      className="scroll-mt-24 space-y-4"
      data-testid={`portfolio-section-${id}`}
    >
      <h2 className="mi-eyebrow border-b border-border pb-1.5">{label}</h2>
      {children}
    </section>
  );
}

// Mirrors the loaded page: header, four stat tiles, then a card of rows.
// Also used by App.tsx while /me resolves so the front door never goes blank.
export function PortfolioSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-4 w-96 max-w-full mt-2" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function PortfolioHeader({
  description,
  canImport,
  onAddClient,
}: {
  description: string;
  canImport: boolean;
  onAddClient: () => void;
}) {
  return (
    <WorkspaceHeader
      eyebrow="Firm command centre"
      title="Client portfolio"
      description={description}
      actions={
        <>
          <Button variant="outline" asChild>
            <Link href="/pipeline">
              <GitBranch className="size-4" aria-hidden="true" />
              Onboarding
            </Link>
          </Button>
          <Button
            variant="outline"
            onClick={onAddClient}
            data-testid="button-add-client"
          >
            <Plus className="size-4" aria-hidden="true" />
            Add client
          </Button>
          {canImport && (
            <Button asChild>
              <Link href="/clients/import">
                <Upload className="size-4" aria-hidden="true" />
                Import clients
              </Link>
            </Button>
          )}
        </>
      }
    />
  );
}

// The four firm-wide stat tiles under the header.
export function PortfolioSummaryStrip({ data }: { data: PortfolioSummary }) {
  return (
    <MetricStrip label="Firm portfolio summary">
      <Metric
        label="Clients"
        value={String(data.clientCount)}
        detail="Active clients"
        icon={<Users className="size-4" aria-hidden="true" />}
        testId="stat-clients"
      />
      <Metric
        label="High-risk clients"
        value={String(data.highRiskCount)}
        detail="Partner attention"
        icon={<AlertTriangle className="size-4" aria-hidden="true" />}
        tone={data.highRiskCount > 0 ? "critical" : "default"}
        testId="stat-high-risk"
      />
      <Metric
        label="Unsubmitted invoices"
        value={String(data.totalUnsubmittedCount)}
        detail={`${formatNaira(data.totalUnsubmittedValue)} awaiting submission`}
        icon={<FileWarning className="size-4" aria-hidden="true" />}
        tone={data.totalUnsubmittedCount > 0 ? "warning" : "default"}
        testId="stat-unsubmitted"
      />
      <Metric
        label="Overdue deadlines"
        value={String(data.totalOverdueCount)}
        detail="Across the firm"
        icon={<Clock className="size-4" aria-hidden="true" />}
        tone={data.totalOverdueCount > 0 ? "critical" : "default"}
        testId="stat-overdue"
      />
    </MetricStrip>
  );
}
