import { Link } from "wouter";
import {
  getGetMonthEndCloseQueryKey,
  useGetMe,
  useGetMonthEndClose,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  CalendarCheck2,
  CheckCircle2,
  Clock3,
} from "lucide-react";
import {
  Metric,
  MetricStrip,
  WorkQueue,
  WorkspaceHeader,
  type WorkQueueItem,
} from "@workspace/web-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { MonthEndCloseCard } from "@/pages/dashboard";
import { vatMonthLabel } from "@/pages/vat";
import { usePageTitle } from "@/hooks/use-page-title";
import { formatLagosDate, pillClasses } from "@/lib/format";

// Exact key -> destination over the month-end contract's item keys
// (api-server modules/invoice/month-end-close.ts). Keys this build doesn't
// know (a newer server) fall back to the invoice vault. A destination that
// rides a launch-dark feature or a missing capability yields NO Review
// button at all — the sidebar hides those pages (PL-02), so the checklist
// must not deep-link into them; the item's detail sentence still says what
// needs doing. Gates mirror components/layout.tsx's NavLink capability/
// feature pair exactly.
const ITEM_DESTINATIONS: Record<
  string,
  { href: string; capability?: string; feature?: string }
> = {
  overdue_submissions: { href: "/invoices" },
  unbilled_income: { href: "/invoices/new" },
  unmatched_credits: { href: "/reconciliation", feature: "reconciliation" },
  missing_bills: { href: "/bills", feature: "money_analytics" },
  double_payments: { href: "/bills", feature: "money_analytics" },
  unmatched_collections: {
    href: "/collections",
    feature: "collection_accounts",
  },
  open_obligations: {
    href: "/obligations",
    capability: "obligation.read",
    feature: "statutory_desks",
  },
  open_filings: {
    href: "/filings",
    capability: "filing.read",
    feature: "statutory_desks",
  },
  wht_credits: {
    href: "/wht",
    capability: "invoice.read",
    feature: "statutory_desks",
  },
  pending_approvals: { href: "/invoices" },
};

export function destinationFor(
  key: string,
  features: ReadonlySet<string>,
  capabilities: ReadonlySet<string>,
): string | null {
  const dest = ITEM_DESTINATIONS[key] ?? { href: "/invoices" };
  if (dest.capability && !capabilities.has(dest.capability)) return null;
  if (dest.feature && !features.has(dest.feature)) return null;
  return dest.href;
}

export function MonthEnd() {
  usePageTitle("Month-end close");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId ?? "";
  const query = useGetMonthEndClose(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetMonthEndCloseQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );

  if (query.isLoading || !me) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="space-y-6">
        <WorkspaceHeader
          eyebrow="Close"
          title="Month-end"
          description="Review the records that need attention before completing your month-end checks."
        />
        <QueryError
          thing="the month-end close"
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }

  const close = query.data;
  const features = new Set(me.features);
  const capabilities = new Set(me.capabilities);
  const workItems: WorkQueueItem[] = close.items
    .filter((item) => item.status === "attention")
    .map((item) => {
      const href = destinationFor(item.key, features, capabilities);
      return {
        id: item.key,
        title: item.label,
        description: item.detail,
        meta:
          item.count > 0
            ? `${item.count} item${item.count === 1 ? "" : "s"}`
            : undefined,
        tone: "warning" as const,
        icon: <AlertTriangle className="size-4" aria-hidden="true" />,
        action: href ? (
          <Button asChild size="sm" variant="outline">
            <Link href={href}>Review</Link>
          </Button>
        ) : undefined,
      };
    });

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Close"
        title="Month-end"
        description={
          <>
            Review unfinished invoices, payment checks, tax filings and approved
            automatic actions.{" "}
            <Link
              href="/help#month-end"
              className="font-bold text-teal-800 underline underline-offset-2"
              data-testid="link-help-month-end"
            >
              About month-end checks
            </Link>
          </>
        }
        status={
          close.attentionCount > 0 ? (
            <span className={pillClasses("amber")}>Review required</span>
          ) : (
            <span className={pillClasses("emerald")}>All checks clear</span>
          )
        }
      />

      <p
        className="text-sm text-muted-foreground"
        data-testid="text-close-explainer"
      >
        {vatMonthLabel(close.asOf)} checks. Review these before completing your
        month-end records. Valo records the checks; you or your accountant
        decide when the month is complete.
      </p>

      <MetricStrip label="Month-end status">
        <Metric
          label="Needs review"
          value={String(close.attentionCount)}
          detail="Checks requiring action"
          icon={<AlertTriangle className="size-4" aria-hidden="true" />}
          tone={close.attentionCount > 0 ? "warning" : "default"}
        />
        <Metric
          label="Clear checks"
          value={String(close.items.length - close.attentionCount)}
          detail={`${close.items.length} total controls`}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
          tone="positive"
        />
        <Metric
          label="As of"
          value={formatLagosDate(close.asOf)}
          detail="Latest close snapshot"
          icon={<Clock3 className="size-4" aria-hidden="true" />}
        />
        <Metric
          label="Close mode"
          value="Human reviewed"
          detail="Clerk actions remain approval-gated"
          icon={<CalendarCheck2 className="size-4" aria-hidden="true" />}
          tone="info"
        />
      </MetricStrip>

      <WorkQueue
        title="Close blockers"
        description="Resolve these checks before treating the month as complete."
        items={workItems}
        emptyTitle="Every close check is clear"
        emptyDescription="The current snapshot has no unresolved controls."
      />

      <div className="max-w-4xl">
        <MonthEndCloseCard clientPartyId={clientPartyId} />
      </div>
    </div>
  );
}
