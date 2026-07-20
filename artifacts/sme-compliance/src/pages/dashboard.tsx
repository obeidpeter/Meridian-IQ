import {
  useGetMe,
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
  useListClientStatements,
  getListClientStatementsQueryKey,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetReceivablesSummary,
  getGetReceivablesSummaryQueryKey,
  useListUnbilledIncome,
  getListUnbilledIncomeQueryKey,
  useListPaymentBehaviour,
  getListPaymentBehaviourQueryKey,
  useGetCashflowOutlook,
  getGetCashflowOutlookQueryKey,
  useGetChaseList,
  getGetChaseListQueryKey,
  useGetUnmatchedCredits,
  getGetUnmatchedCreditsQueryKey,
  useGetProjectionAccuracy,
  getGetProjectionAccuracyQueryKey,
} from "@workspace/api-client-react";
import type { ReceivablesBucket, ReceivablesSummary } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Activity,
  Sparkles,
  CalendarCheck,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import {
  formatDate,
  formatNaira,
  statusLabel,
  badgeClasses,
  severityLabel,
  severityBadgeClasses,
} from "@/lib/format";

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  href,
  danger,
}: {
  label: string;
  value: string;
  sub: string;
  icon: typeof Clock;
  href: string;
  danger?: boolean;
}) {
  return (
    <Link
      href={href}
      className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card
        className={`h-full transition-colors hover:border-primary/50 ${
          danger ? "border-destructive/50 bg-destructive/5" : ""
        }`}
      >
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="text-2xl font-bold mt-1">{value}</p>
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            </div>
            <Icon
              className={`w-8 h-8 ${danger ? "text-destructive" : "text-primary"}`}
              aria-hidden="true"
            />
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function AgingBucketRow({
  label,
  bucket,
  tone,
}: {
  label: string;
  bucket: ReceivablesBucket;
  tone?: "warning" | "danger";
}) {
  // The late buckets only take their warning/danger tone once something is
  // actually sitting in them.
  const nonZero = bucket.count > 0 || Number(bucket.amount) > 0;
  const toneClass =
    nonZero && tone === "danger"
      ? "text-destructive"
      : nonZero && tone === "warning"
        ? "text-amber-700 dark:text-amber-400"
        : "";
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium tabular-nums ${toneClass}`}>
        {formatNaira(bucket.amount)}
        <span className="text-xs text-muted-foreground font-normal">
          {" "}
          · {bucket.count}
        </span>
      </span>
    </div>
  );
}

// First-run nudge gate: the quiet "create your first invoice" link renders
// ONLY when the client has no invoices AT ALL — an active book whose
// receivables happen to be settled has earned silence, not a nag. Undefined
// (summary still loading or failed) shows nothing rather than guessing.
export function showFirstInvoiceCta(
  totalInvoices: number | undefined,
): boolean {
  return totalInvoices === 0;
}

function ReceivablesCard({
  summary,
  isLoading,
  isError,
  clientPartyId,
  totalInvoices,
  onRetry,
}: {
  summary: ReceivablesSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  clientPartyId: string;
  totalInvoices: number | undefined;
  onRetry: () => void;
}) {
  const primary = summary?.groups[0];

  // Buyer payment rhythm (round-9 idea #1): per-buyer days-to-pay medians
  // mined server-side from this client's own accepted reconciliation
  // matches. Informational chip only — the per-invoice "beyond their usual"
  // judgement lives on the invoice detail, where both sides of the
  // comparison share the same anchor date.
  const { data: behaviour } = useListPaymentBehaviour(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId && !!summary?.topDebtors.length,
        queryKey: getListPaymentBehaviourQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const rhythmByBuyer = new Map(
    (behaviour ?? []).map((b) => [b.buyerPartyId, b.medianDaysToPay]),
  );

  // CSV of the per-invoice rows behind this aging summary, as a plain browser
  // navigation (no query hook): the endpoint answers with a Content-Disposition
  // attachment and auth rides the session cookie.
  const exportCsv = () => {
    window.location.assign(
      `/api/dashboard/receivables/export?clientPartyId=${encodeURIComponent(clientPartyId)}`,
    );
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Receivables
        </CardTitle>
        {!!clientPartyId && !!primary && (
          <Button
            variant="ghost"
            size="sm"
            onClick={exportCsv}
            data-testid="button-export-receivables-csv"
          >
            <Download className="w-4 h-4 mr-1.5" aria-hidden="true" />
            Export CSV
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : isError ? (
          <QueryError thing="your receivables" onRetry={onRetry} />
        ) : !summary || !primary ? (
          <div
            className="text-sm text-muted-foreground text-center py-4"
            data-testid="text-receivables-empty"
          >
            No outstanding receivables.
            {showFirstInvoiceCta(totalInvoices) && (
              <>
                {" "}
                <Link
                  href="/invoices/new"
                  className="text-primary hover:underline"
                  data-testid="link-first-invoice"
                >
                  Create your first invoice
                </Link>{" "}
                to start tracking what you&apos;re owed.
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p
                className="text-2xl font-bold tabular-nums"
                data-testid="text-receivables-total"
              >
                {formatNaira(primary.outstandingTotal)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Outstanding across {primary.invoiceCount} invoice
                {primary.invoiceCount === 1 ? "" : "s"}
                {summary.groups.length > 1
                  ? ` · +${summary.groups.length - 1} more ${
                      summary.groups.length === 2 ? "currency" : "currencies"
                    }`
                  : ""}
              </p>
            </div>
            <div className="space-y-2">
              <AgingBucketRow
                label="Current (≤30d)"
                bucket={primary.buckets.current}
              />
              <AgingBucketRow
                label="31–60 days"
                bucket={primary.buckets.days31to60}
              />
              <AgingBucketRow
                label="61–90 days"
                bucket={primary.buckets.days61to90}
                tone="warning"
              />
              <AgingBucketRow
                label="90+ days"
                bucket={primary.buckets.days90plus}
                tone="danger"
              />
            </div>
            {summary.topDebtors.length > 0 && (
              <div className="pt-3 border-t">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Top debtors
                </p>
                <div className="space-y-2">
                  {summary.topDebtors.map((debtor) => (
                    <div
                      key={debtor.buyerPartyId}
                      className="flex items-center justify-between gap-3 text-sm"
                    >
                      <span className="min-w-0 truncate">
                        {debtor.buyerName}
                        {rhythmByBuyer.has(debtor.buyerPartyId) && (
                          <span
                            className="ml-1.5 text-xs text-muted-foreground"
                            data-testid={`rhythm-${debtor.buyerPartyId}`}
                          >
                            usually pays ~{rhythmByBuyer.get(debtor.buyerPartyId)}d
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatNaira(debtor.outstanding)}
                        <span className="text-xs text-muted-foreground font-normal">
                          {" "}
                          · {debtor.invoiceCount} inv
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// "Your week" — the firm's latest weekly Clerk digest. Firm-only surface
// (clerk.ask, like the Ask Clerk page): the parent checks the capability
// before mounting this, so a client_user never fires the request. Read-only
// and pre-generated server-side, so it spends no tokens; renders only on
// success — no digest yet (404) or any error means no card at all.
function ClerkDigestCard() {
  const { data: digest, isSuccess } = useGetClerkDigest({
    query: { queryKey: getGetClerkDigestQueryKey(), retry: false },
  });
  if (!isSuccess || !digest) return null;
  return (
    <Card data-testid="clerk-digest">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Your week
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold">{digest.headline}</p>
        {digest.bullets.length > 0 && (
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-4">
            {digest.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Week of {formatDate(digest.weekStart)}
          {digest.source === "clerk" && " · Written by Clerk"}
        </p>
      </CardContent>
    </Card>
  );
}

// "2026-06-01" -> "June 2026" for the statement's display period.
const STATEMENT_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
function statementMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${STATEMENT_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// Per-client monthly statement (idea #5): the newest CLOSED month's summary
// for this client, generated server-side on the opt-in sweep. Client-scoped
// (clerk.capture, the client's own party), read-only, renders only on
// success — no statement yet or any error means no card at all.
function ClientStatementCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: statements, isSuccess } = useListClientStatements(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListClientStatementsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  const statement = statements?.[0];
  if (!isSuccess || !statement) return null;
  return (
    <Card data-testid="client-statement">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Your
          compliance month
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold">{statement.headline}</p>
        {statement.bullets.length > 0 && (
          <ul className="space-y-1.5 text-sm text-muted-foreground list-disc pl-4">
            {statement.bullets.map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {statementMonthLabel(statement.monthStart)}
          {statement.source === "clerk" && " · Written by Clerk"}
        </p>
      </CardContent>
    </Card>
  );
}

// Unbilled-income nudges (round-8 idea #1): buyers this client bills every
// month where the usual billing day has passed with nothing issued. Mined
// deterministically server-side from the client's own history — nothing
// stored, no model. Renders only when there is something to say.
function UnbilledIncomeCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: alerts, isSuccess } = useListUnbilledIncome(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListUnbilledIncomeQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  if (!isSuccess || !alerts || alerts.length === 0) return null;
  return (
    <Card data-testid="unbilled-income">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Money you usually
          bill
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Based on your own invoice history, these regular invoices look
          unraised this cycle.
        </p>
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={a.buyerPartyId}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid={`unbilled-${a.buyerPartyId}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{a.buyerName}</p>
                <p className="text-xs text-muted-foreground">
                  Usually about {formatNaira(a.medianAmount)} every ~
                  {a.medianGapDays} days · last invoiced{" "}
                  {formatDate(a.lastIssueDate)}
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/invoices/new">Draft invoice</Link>
              </Button>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Worked out from your own invoices — if an arrangement ended, you can
          ignore this.
        </p>
      </CardContent>
    </Card>
  );
}

// Unmatched credits (round-14 idea #1): bank credits with no invoice behind
// them — the compliance mirror of the unbilled card above. If any of these
// is a sale, an e-invoice should exist for it. Deterministic advisory,
// renders only when something needs looking at.
function UnmatchedCreditsCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: credits, isSuccess } = useGetUnmatchedCredits(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetUnmatchedCreditsQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!isSuccess || !credits || credits.count === 0) return null;
  return (
    <Card data-testid="unmatched-credits">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" aria-hidden="true" /> Money in with no
          invoice
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {credits.count} bank credit{credits.count === 1 ? "" : "s"} totalling{" "}
          {formatNaira(credits.totalAmount)} from the last{" "}
          {credits.windowDays} days match no invoice on the platform.
        </p>
        <div className="space-y-2">
          {credits.rows.slice(0, 5).map((r) => (
            <div
              key={r.lineId}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid={`unmatched-credit-${r.lineId}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">
                  {r.counterpartyRef || r.narration || "Unnamed credit"}
                </p>
                <p className="text-xs text-muted-foreground">
                  Received {formatDate(r.valueDate)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums text-sm">
                  {formatNaira(r.amount)}
                </span>
                <Button asChild size="sm" variant="secondary">
                  <Link href="/invoices/new">Raise invoice</Link>
                </Button>
              </div>
            </div>
          ))}
        </div>
        {(credits.truncated || credits.rows.length > 5) && (
          <p className="text-xs text-muted-foreground">
            Showing the largest — reconcile your statements to see the rest.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {credits.note}
        </p>
      </CardContent>
    </Card>
  );
}

// Cash-flow outlook (round-10 idea #1): expected inflows by week, projected
// server-side from each buyer's own payment rhythm (falling back to due
// dates / standard terms). Deterministic, renders only when there is money
// outstanding.
function CashflowCard({ clientPartyId }: { clientPartyId: string }) {
  // Projection accuracy (round-14 idea #2): the forecast auditing itself —
  // a confidence line under the outlook when enough settlements exist.
  const { data: accuracy } = useGetProjectionAccuracy(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetProjectionAccuracyQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const { data: outlook, isSuccess } = useGetCashflowOutlook(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetCashflowOutlookQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const group = outlook?.groups[0];
  if (!isSuccess || !group || group.total.count === 0) return null;
  const weekLabel = (i: number) =>
    i === 0 ? "This week" : i === 1 ? "Next week" : `Week +${i}`;
  return (
    <Card data-testid="cashflow-outlook">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" aria-hidden="true" /> Expected inflows
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {group.overdueExpected.count > 0 && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/40">
            <span className="text-amber-800 dark:text-amber-300">
              Already past expected ({group.overdueExpected.count} inv)
            </span>
            <span className="font-semibold tabular-nums text-amber-800 dark:text-amber-300">
              {formatNaira(group.overdueExpected.amount)}
            </span>
          </div>
        )}
        {group.weeks.map((w, i) => (
          <div
            key={w.startDate}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-muted-foreground">
              {weekLabel(i)}
              <span className="text-xs"> · {w.count} inv</span>
            </span>
            <span className="font-medium tabular-nums">
              {formatNaira(w.amount)}
            </span>
          </div>
        ))}
        {group.later.count > 0 && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">
              Later <span className="text-xs">· {group.later.count} inv</span>
            </span>
            <span className="font-medium tabular-nums">
              {formatNaira(group.later.amount)}
            </span>
          </div>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Projected from each customer&apos;s own payment history where we
          have one, otherwise due dates. {group.currency} only
          {outlook.groups.length > 1 ? " (other currencies not shown)" : ""}.
          {accuracy &&
            accuracy.settlements >= 5 &&
            accuracy.medianAbsErrorDays != null && (
              <span data-testid="projection-accuracy">
                {" "}
                Past projections have landed within about ±
                {Math.round(accuracy.medianAbsErrorDays)} day
                {Math.round(accuracy.medianAbsErrorDays) === 1 ? "" : "s"} of
                actual payment ({accuracy.settlements} matched payments).
              </span>
            )}
        </p>
      </CardContent>
    </Card>
  );
}

// Chase list (round-10 idea #2): the receivables most worth chasing this
// week — ranked by days beyond each buyer's OWN expected payment date, not
// raw age. Each row opens the invoice, where the reminder-draft button is.
function ChaseListCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: rows, isSuccess } = useGetChaseList(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetChaseListQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  if (!isSuccess || !rows || rows.length === 0) return null;
  return (
    <Card data-testid="chase-list">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="w-5 h-5" aria-hidden="true" /> Worth chasing
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.invoiceId}
            className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
            data-testid={`chase-${r.invoiceId}`}
          >
            <div className="min-w-0">
              <p className="font-semibold truncate">{r.buyerName}</p>
              <p className="text-xs text-muted-foreground">
                {r.invoiceNumber} ·{" "}
                {r.currency === "NGN"
                  ? formatNaira(r.grandTotal)
                  : `${r.currency} ${r.grandTotal}`}{" "}
                · {r.daysBeyondExpected}d{" "}
                {r.basis === "rhythm"
                  ? "beyond their usual"
                  : r.basis === "dueDate"
                    ? "past due"
                    : "past standard terms"}
                {r.basis === "rhythm" && r.dueDate
                  ? ` · was due ${formatDate(r.dueDate)}`
                  : ""}
              </p>
            </div>
            <Button asChild size="sm" variant="secondary">
              <Link href={`/invoices/${r.invoiceId}`}>Chase</Link>
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          Ranked by how far each invoice is past that customer&apos;s own
          payment rhythm. Open one to draft a reminder.
        </p>
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="pt-6 space-y-2">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-8 w-16" />
              <Skeleton className="h-3 w-24" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <Skeleton className="h-5 w-40" />
            </CardHeader>
            <CardContent className="space-y-3">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export function Dashboard() {
  usePageTitle("Dashboard");
  const { data: me } = useGetMe();
  // Same capability check CapabilityGate applies, minus its denial card: a
  // dashboard tile should simply be absent for roles that can't use it.
  const canAskClerk = !!me?.capabilities.includes("clerk.ask");
  // The monthly statement belongs to the client whose month it is (capture,
  // not ask), so a client_user sees it even though it never sees the digest.
  const canSeeStatement = !!me?.capabilities.includes("clerk.capture");
  const {
    data: summary,
    isLoading,
    isError,
    refetch,
  } = useGetDashboardSummary(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetDashboardSummaryQueryKey({
          clientPartyId: me?.clientPartyId || "",
        }),
      },
    },
  );
  const {
    data: receivables,
    isLoading: receivablesLoading,
    isError: receivablesError,
    refetch: refetchReceivables,
  } = useGetReceivablesSummary(
    { clientPartyId: me?.clientPartyId || "" },
    {
      query: {
        enabled: !!me?.clientPartyId,
        queryKey: getGetReceivablesSummaryQueryKey({
          clientPartyId: me?.clientPartyId || "",
        }),
      },
    },
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Compliance overview"
        description="Stay ahead of your filing deadlines."
      >
        <Button asChild>
          <Link href="/invoices/new">New invoice</Link>
        </Button>
      </PageHeader>

      <RequireClientScope thing="compliance summary">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError ? (
          <QueryError thing="your compliance summary" onRetry={() => refetch()} />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Pending invoices"
                value={String(summary?.pendingCount ?? 0)}
                sub="Awaiting stamp"
                icon={Clock}
                href="/invoices"
              />
              <StatCard
                label="Stamped & valid"
                value={String(summary?.stampedCount ?? 0)}
                sub={`${formatNaira(summary?.stampedValue)} total value`}
                icon={CheckCircle}
                href="/invoices"
              />
              <StatCard
                label="Drafts"
                value={String(summary?.draftCount ?? 0)}
                sub="Needs completion"
                icon={FileText}
                href="/invoices"
              />
              <StatCard
                label="At risk"
                value={String(summary?.atRiskCount ?? 0)}
                sub="Needs attention"
                icon={AlertTriangle}
                href="/calendar"
                danger={!!summary?.atRiskCount}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Activity className="w-5 h-5" aria-hidden="true" /> Recent activity
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summary?.recentActivity && summary.recentActivity.length > 0 ? (
                    <div className="space-y-4">
                      {summary.recentActivity.map((activity) => (
                        <div
                          key={activity.id}
                          className="flex items-center justify-between gap-3"
                        >
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">
                              {activity.label}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatDate(activity.at)}
                            </p>
                          </div>
                          {activity.status && (
                            <span className={badgeClasses(activity.status)}>
                              {statusLabel(activity.status)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No recent activity
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Clock className="w-5 h-5" aria-hidden="true" /> Next deadline
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {summary?.nextDeadline ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium">
                          {summary.nextDeadline.title}
                        </span>
                        <span
                          className={severityBadgeClasses(
                            summary.nextDeadline.severity,
                          )}
                        >
                          {severityLabel(summary.nextDeadline.severity)}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {formatDate(summary.nextDeadline.dueDate)}
                      </p>
                      <Link
                        href="/calendar"
                        className="text-primary text-sm mt-2 hover:underline"
                      >
                        View calendar
                      </Link>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground text-center py-4">
                      No upcoming deadlines
                    </div>
                  )}
                </CardContent>
              </Card>

              <ReceivablesCard
                summary={receivables}
                isLoading={receivablesLoading}
                isError={receivablesError}
                clientPartyId={me?.clientPartyId || ""}
                totalInvoices={summary?.totalInvoices}
                onRetry={() => refetchReceivables()}
              />

              {canAskClerk && <ClerkDigestCard />}

              {canSeeStatement && me?.clientPartyId && (
                <ClientStatementCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <UnbilledIncomeCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <UnmatchedCreditsCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <CashflowCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <ChaseListCard clientPartyId={me.clientPartyId} />
              )}
            </div>
          </>
        )}
      </RequireClientScope>
    </div>
  );
}
