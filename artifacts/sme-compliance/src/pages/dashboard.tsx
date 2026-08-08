import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useCreatePlanRun,
  useGetPlanPolicies,
  getGetPlanPoliciesQueryKey,
  useGrantPlanPolicy,
  usePausePlanPolicy,
  useResumePlanPolicy,
  useRevokePlanPolicy,
  useGetClerkDigest,
  getGetClerkDigestQueryKey,
  useGetClientAutomationEvidence,
  getGetClientAutomationEvidenceQueryKey,
  useListClientStatements,
  getListClientStatementsQueryKey,
  useListAdvisoryBriefs,
  getListAdvisoryBriefsQueryKey,
  useGetDashboardSummary,
  getGetDashboardSummaryQueryKey,
  useGetReceivablesSummary,
  getGetReceivablesSummaryQueryKey,
  useListUnbilledIncome,
  getListUnbilledIncomeQueryKey,
  useListPaymentBehaviour,
  getListPaymentBehaviourQueryKey,
  useGetCashflowOutlook,
  useGetNetCashPosition,
  getGetNetCashPositionQueryKey,
  getGetCashflowOutlookQueryKey,
  useGetChaseList,
  getGetChaseListQueryKey,
  useGetChaseEffectiveness,
  getGetChaseEffectivenessQueryKey,
  useGetUnmatchedCredits,
  getGetUnmatchedCreditsQueryKey,
  useGetProjectionAccuracy,
  getGetProjectionAccuracyQueryKey,
  useGetPayablesSummary,
  getGetPayablesSummaryQueryKey,
  useGetPenaltyExposure,
  getGetPenaltyExposureQueryKey,
  useGetMonthEndClose,
  getGetMonthEndCloseQueryKey,
} from "@workspace/api-client-react";
import type {
  CashflowBucket,
  PayablesSummaryGroupsItem,
  ReceivablesBucket,
  ReceivablesSummary,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { ClerkActionsCard } from "@/components/clerk-actions-card";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { errorStatus } from "@workspace/api-errors";
import { serverErrorMessage } from "@/lib/errors";
import { PlanRunProgress } from "./clerk-ask";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Activity,
  Sparkles,
  CalendarCheck,
  Receipt,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkQueue,
  WorkspaceHeader,
  type WorkQueueItem,
} from "@workspace/web-ui";
import {
  formatAmount,
  formatDate,
  formatNaira,
  planEvidenceLine,
  statusLabel,
  badgeClasses,
  severityLabel,
  severityBadgeClasses,
  summaryPillClasses,
} from "@/lib/format";

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

export function ReceivablesCard({
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
                            usually pays ~
                            {rhythmByBuyer.get(debtor.buyerPartyId)}d
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

/**
 * The payables card keeps three visual buckets (mirroring the receivables
 * card's at-a-glance shape): Overdue, Due this week (dueWeeks[0]), and
 * everything beyond — the remaining weekly buckets folded into `later`.
 * Exported for the unit tests.
 */
export function dueLaterBucket(
  group: PayablesSummaryGroupsItem,
): CashflowBucket {
  const rest = group.dueWeeks.slice(1);
  const amount =
    rest.reduce((sum, w) => sum + Number(w.amount), 0) +
    Number(group.later.amount);
  const count = rest.reduce((sum, w) => sum + w.count, 0) + group.later.count;
  return { amount: amount.toFixed(2), count };
}

// Committed outflows — the payables mirror of the receivables card, fed by
// the bills book (supplier invoices where this client is the buyer).
// Render-on-success: while loading, on error, or with nothing committed the
// card is simply absent, like the other advisory dashboard cards.
export function PayablesCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: summary, isSuccess } = useGetPayablesSummary(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPayablesSummaryQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const primary = summary?.groups[0];
  if (!isSuccess || !summary || !primary) return null;
  return (
    <Card data-testid="card-payables">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Receipt className="w-5 h-5" aria-hidden="true" /> Payables
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <p
              className="text-2xl font-bold tabular-nums"
              data-testid="text-payables-total"
            >
              {formatNaira(primary.total.amount)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Committed across {primary.total.count} bill
              {primary.total.count === 1 ? "" : "s"}
              {summary.groups.length > 1
                ? ` · +${summary.groups.length - 1} more ${
                    summary.groups.length === 2 ? "currency" : "currencies"
                  }`
                : ""}
            </p>
          </div>
          <div className="space-y-2">
            <AgingBucketRow
              label="Overdue"
              bucket={primary.overdue}
              tone="danger"
            />
            <AgingBucketRow
              label="Due this week"
              bucket={primary.dueWeeks[0] ?? { amount: "0", count: 0 }}
              tone="warning"
            />
            <AgingBucketRow
              label="Due later"
              bucket={dueLaterBucket(primary)}
            />
          </div>
          {summary.topSuppliers.length > 0 && (
            <div className="pt-3 border-t">
              <p className="text-xs font-medium text-muted-foreground mb-2">
                Top suppliers
              </p>
              <div className="space-y-2">
                {summary.topSuppliers.map((supplier) => (
                  <div
                    key={supplier.supplierPartyId}
                    className="flex items-center justify-between gap-3 text-sm"
                    data-testid={`payables-supplier-${supplier.supplierPartyId}`}
                  >
                    <span className="min-w-0 truncate">
                      {supplier.supplierName}
                    </span>
                    <span className="shrink-0 font-medium tabular-nums">
                      {formatNaira(supplier.amount)}
                      <span className="text-xs text-muted-foreground font-normal">
                        {" "}
                        · {supplier.count} bill{supplier.count === 1 ? "" : "s"}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <Link
            href="/bills"
            className="text-primary text-sm inline-block hover:underline"
            data-testid="link-view-bills"
          >
            View bills
          </Link>
        </div>
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

// Advisory brief (Advise with Clerk, round 49): the firm's monthly
// advisory work product for this client — deterministic evidence-cited
// sections, adviser's note phrased at most once (source says which path).
// Client-scoped exactly like the statement card (SEC-03 is server-side:
// the route pins a client_user to its own party); renders only when the
// firm has generated one.
function AdvisoryBriefCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: briefs, isSuccess } = useListAdvisoryBriefs(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getListAdvisoryBriefsQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  const brief = briefs?.[0];
  if (!isSuccess || !brief) return null;
  return (
    <Card data-testid="advisory-brief">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Your
          adviser's brief
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="font-semibold" data-testid="text-brief-headline">
          {brief.headline}
        </p>
        <p className="text-sm text-muted-foreground">{brief.note}</p>
        <div className="space-y-2">
          {brief.sections.map((section) => (
            <div
              key={section.key}
              className="border rounded-md p-3 space-y-1"
              data-testid={`brief-section-${section.key}`}
            >
              <p className="text-sm font-medium">{section.title}</p>
              <p className="text-sm">{section.text}</p>
              <div className="text-xs text-muted-foreground space-y-0.5">
                {section.facts.map((f) => (
                  <p key={f.key}>
                    {f.label}:{" "}
                    <span className="font-medium tabular-nums">
                      {f.value}
                      {f.unit ? ` ${f.unit}` : ""}
                    </span>
                  </p>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Source: {section.sourceReport}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {statementMonthLabel(brief.monthStart)}
          {brief.source === "clerk" && " · Note written by Clerk"}
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
              key={`${a.buyerPartyId}-${a.currency}`}
              className="flex items-center justify-between gap-3 rounded-lg border p-3"
              data-testid={`unbilled-${a.buyerPartyId}-${a.currency}`}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{a.buyerName}</p>
                <p className="text-xs text-muted-foreground">
                  Usually about {formatAmount(a.medianAmount, a.currency)} every
                  ~{a.medianGapDays} days · last invoiced{" "}
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

// Month-end close (round 19): the platform's deterministic advisories
// composed into one checklist — each line computed by the same check that
// powers its own card, so the two can never disagree. Advisory only; a
// human closes the month.
export function MonthEndCloseCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { data: close, isSuccess } = useGetMonthEndClose(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetMonthEndCloseQueryKey({ clientPartyId }),
        // The checklist composes seven detector queries server-side —
        // don't re-run the sweep on every dashboard focus.
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  // Run with Clerk (rounds 32/34): the checklist made executable — one
  // approval queues the month_end_close template (draft missing recurring
  // invoices → submit overdue → retry failed), assembled server-side for
  // THIS client and executed by the worker with per-step re-validation.
  // Any drafts the run raises stay DRAFTS behind the machine-draft
  // submission wall until a human reviews and renumbers them. A 409 means
  // nothing is currently eligible — an honest no-op, not an error.
  const { toast } = useToast();
  const createRun = useCreatePlanRun();
  const [runId, setRunId] = useState<string | null>(null);
  if (!isSuccess || !close) return null;
  return (
    <Card data-testid="month-end-close">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Month-end
          close
          {close.attentionCount > 0 ? (
            <span
              className={`ml-auto ${summaryPillClasses("amber")}`}
              data-testid="text-close-attention-count"
            >
              {close.attentionCount} to review
            </span>
          ) : (
            <span
              className={`ml-auto ${summaryPillClasses("emerald")}`}
              data-testid="text-close-all-clear"
            >
              All clear
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-2">
          {close.items.map((item) => (
            <li
              key={item.key}
              className="flex items-start gap-2.5 text-sm"
              data-testid={`close-item-${item.key}`}
            >
              {item.status === "attention" ? (
                <AlertTriangle
                  className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
              ) : (
                <CheckCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
              )}
              <div className="min-w-0">
                <p
                  className={
                    item.status === "attention"
                      ? "font-medium"
                      : "text-muted-foreground"
                  }
                >
                  {item.label}
                  {item.count > 0 && (
                    <span className="ml-1.5 tabular-nums">({item.count})</span>
                  )}
                </p>
                {item.status === "attention" && (
                  <p className="text-xs text-muted-foreground">{item.detail}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
        {runId ? (
          <PlanRunProgress runId={runId} />
        ) : (
          close.attentionCount > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={createRun.isPending}
              data-testid="button-run-month-end"
              onClick={() =>
                createRun.mutate(
                  {
                    data: { templateKey: "month_end_close", clientPartyId },
                  },
                  {
                    onSuccess: (run) => setRunId(run.id),
                    onError: (e) =>
                      // 409 = the honest empty (NOTHING_TO_RUN); anything
                      // else is a real failure and must not read as one.
                      toast(
                        errorStatus(e) === 409
                          ? {
                              title: "Nothing to run right now",
                              description:
                                "No invoices are currently eligible for the close actions — the remaining checklist items need hands-on attention.",
                            }
                          : {
                              title: "Couldn't start the close run",
                              description:
                                "Nothing was changed. Try again shortly, or use the actions card.",
                            },
                      ),
                  },
                )
              }
            >
              {createRun.isPending ? "Starting…" : "Run with Clerk"}
            </Button>
          )
        )}
        <MonthlyAutomationStrip clientPartyId={clientPartyId} />
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {close.note}
        </p>
      </CardContent>
    </Card>
  );
}

// Run monthly (round 33, Do with Clerk Phase 3): a standing approval for
// the month_end_close plan. The sweep mints ONE run per Lagos month per
// grant — the exact machinery the "Run with Clerk" button above drives by
// hand, per-step re-validation and decision-ledger rows included. Tripwires
// (a halted run, the approver losing access, a closed engagement, missing
// consent) pause the grant rather than let it keep running.
const PLAN_PAUSE_LABELS: Record<string, string> = {
  manual: "Paused",
  run_halted: "Paused — the last run halted",
  grantor_inactive: "Paused — the approver's access changed",
  engagement_closed: "Paused — the engagement closed",
  consent_missing: "Paused — compliance consent is missing",
  unknown_template: "Paused — the plan template changed",
  run_error: "Paused — the last run hit an error",
};

// "Up to date for", not "last ran": a month is also consumed by the honest
// closing-window empty (nothing was eligible all month), and the hourly
// sweep — not a month-end event — picks up the first eligible paper.
export function planPolicyStatusLine(p: {
  pausedAt?: string | null;
  pausedReason?: string | null;
  lastRunMonth?: string | null;
}): string {
  if (p.pausedAt) return PLAN_PAUSE_LABELS[p.pausedReason ?? ""] ?? "Paused";
  return p.lastRunMonth
    ? `Runs monthly · up to date for ${p.lastRunMonth}`
    : "Runs monthly · runs when there is eligible paper";
}

export function MonthlyAutomationStrip({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const { data } = useGetPlanPolicies(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPlanPoliciesQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // Automation evidence (Prove with Clerk phase 2): the client's OWN
  // backtest, so the monthly consent leads with "your own record".
  // Render-on-success and advisory only — no evidence means no line, and
  // the line never gates the grant button.
  const { data: automationEvidence } = useGetClientAutomationEvidence(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetClientAutomationEvidenceQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const planEvidence = automationEvidence
    ? planEvidenceLine(automationEvidence.kinds)
    : null;
  const onChanged = () =>
    queryClient.invalidateQueries({ queryKey: getGetPlanPoliciesQueryKey() });
  const onError = (e: unknown) =>
    toast({
      title: "Automation change failed",
      description: serverErrorMessage(e),
      variant: "destructive",
    });
  const grant = useGrantPlanPolicy({
    mutation: {
      onSuccess: () => {
        setConfirming(false);
        onChanged();
      },
      onError,
    },
  });
  const pause = usePausePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  const resume = useResumePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  const revoke = useRevokePlanPolicy({
    mutation: { onSuccess: onChanged, onError },
  });
  if (!data) return null;
  const policy = data.policies.find((p) => p.templateKey === "month_end_close");
  // No grant and no way to make one: the strip has nothing to say.
  if (!policy && !data.enabled) return null;
  const busy =
    grant.isPending || pause.isPending || resume.isPending || revoke.isPending;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3 text-xs"
      data-testid="monthly-automation"
    >
      {policy ? (
        <>
          <span className="font-medium text-foreground">
            Monthly automation
          </span>
          <span
            className={
              policy.pausedAt
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
            }
            data-testid="text-plan-policy-status"
          >
            {planPolicyStatusLine(policy)}
          </span>
          <span className="ml-auto flex gap-1">
            {policy.pausedAt ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => resume.mutate({ id: policy.id })}
                disabled={busy}
                data-testid="button-plan-policy-resume"
              >
                Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => pause.mutate({ id: policy.id })}
                disabled={busy}
                data-testid="button-plan-policy-pause"
              >
                Pause
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => revoke.mutate({ id: policy.id })}
              disabled={busy}
              data-testid="button-plan-policy-revoke"
            >
              Revoke
            </Button>
          </span>
        </>
      ) : (
        <>
          <span className="text-muted-foreground">
            Let Clerk run this close every month, with your standing approval.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setConfirming(true)}
            disabled={busy}
            data-testid="button-plan-policy-grant"
          >
            Run monthly
          </Button>
        </>
      )}
      {/* Consent-grade confirm: granting runs no batch — it stands until
          revoked, so the copy says exactly what will happen each month. */}
      <Dialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run month-end close monthly</DialogTitle>
            {/* The client's own backtest, before the consent sentence —
                absent entirely when there is no evidence to show. */}
            {planEvidence && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="text-plan-evidence"
              >
                {planEvidence}
              </p>
            )}
            <DialogDescription>
              Each month, Clerk will run this close plan for your business:
              raise draft invoices for regular customers you have not billed
              this cycle (drafts stay for your review — nothing is sent), submit
              invoices past the reporting window, then retry failed submissions.
              Every step re-checks eligibility at run time and every action is
              recorded. If a run halts, or anything about the engagement,
              consent or the approver changes, the automation pauses itself and
              waits for you. You can pause or revoke it at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={grant.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                grant.mutate({
                  data: { templateKey: "month_end_close", clientPartyId },
                })
              }
              disabled={grant.isPending}
              data-testid="button-confirm-plan-policy"
            >
              {grant.isPending ? "Working…" : "Turn on monthly run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Penalty exposure (round 18): what the overdue paper could cost under
// MeridianIQ's published s.104 model. Renders only when something is
// overdue; always the SMALL-band floor ("at least"), never a scare figure —
// and the fix is stated: submit the paper, the exposure goes away.
function PenaltyExposureCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: exposure, isSuccess } = useGetPenaltyExposure(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetPenaltyExposureQueryKey({ clientPartyId }),
        retry: false,
      },
    },
  );
  if (!isSuccess || !exposure || exposure.overdueCount === 0) return null;
  return (
    <Card
      className="border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
      data-testid="penalty-exposure"
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-5 h-5" aria-hidden="true" /> Estimated
          penalty exposure
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-amber-800 dark:text-amber-300">
        <p className="text-sm">
          {exposure.overdueCount} invoice
          {exposure.overdueCount === 1 ? " is" : "s are"} past the statutory
          submission window — at least{" "}
          <span className="font-semibold" data-testid="text-penalty-floor">
            {formatNaira(exposure.exposure.small)}
          </span>{" "}
          of potential s.104 exposure at the lowest turnover band (
          {formatNaira(exposure.perInvoice.small)} per invoice; higher bands
          reach {formatNaira(exposure.exposure.large)}).
        </p>
        {exposure.sampleInvoices.length > 0 && (
          <div className="space-y-1 text-xs">
            {exposure.sampleInvoices.map((s) => (
              <p
                key={s.invoiceId}
                data-testid={`penalty-invoice-${s.invoiceId}`}
              >
                {s.invoiceNumber} · issued {formatDate(s.issueDate)} ·{" "}
                {s.daysOverdue} day{s.daysOverdue === 1 ? "" : "s"} past the
                window
              </p>
            ))}
          </div>
        )}
        <p className="text-sm font-medium">
          Submitting the overdue invoices removes this exposure.
        </p>
        <p className="text-xs">
          An estimate under MeridianIQ&apos;s published penalty model — not
          legal or tax advice. As of {formatDate(exposure.asOf)}.
        </p>
      </CardContent>
    </Card>
  );
}

// Proposed actions (round 21): the "Clerk suggests" card lives in
// components/clerk-actions-card.tsx (mirroring its console twin's
// placement). Re-exported here so the card's existing import sites —
// dashboard-clerk-actions.test.tsx pins it from this page module — keep
// working unchanged.
export { ClerkActionsCard };

// Unmatched credits (round-14 idea #1): bank credits with no invoice behind
// them — the compliance mirror of the unbilled card above. If any of these
// is a sale, an e-invoice should exist for it. Deterministic advisory,
// renders only when something needs looking at.
export function UnmatchedCreditsCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
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
          {formatNaira(credits.totalAmount)} from the last {credits.windowDays}{" "}
          days match no invoice on the platform.
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

// The week bucket labels the cash-flow outlook and net-position cards
// share: index 0 is the week in progress.
const weekLabel = (i: number) =>
  i === 0 ? "This week" : i === 1 ? "Next week" : `Week +${i}`;

// Net cash position (round-15 idea #2): projected inflows minus committed
// bill outflows per week — the outlook and the payables card merged into
// the number the owner actually wants. Squeeze weeks are flagged, never
// predicted as failure.
function NetPositionCard({ clientPartyId }: { clientPartyId: string }) {
  const { data: position, isSuccess } = useGetNetCashPosition(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetNetCashPositionQueryKey({ clientPartyId }),
        staleTime: 5 * 60_000,
        retry: false,
      },
    },
  );
  const group = position?.groups[0];
  if (!isSuccess || !group) return null;
  const hasMovement = group.weeks.some(
    (w) => w.inflowCount > 0 || w.outflowCount > 0,
  );
  if (!hasMovement) return null;
  return (
    <Card data-testid="net-position">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" aria-hidden="true" /> Net cash position
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {group.weeks.map((w, i) => (
          <div
            key={w.startDate}
            className={`flex items-center justify-between gap-3 rounded-lg p-2 ${
              w.squeeze
                ? "border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40"
                : ""
            }`}
            data-testid={`net-week-${i}`}
          >
            <span className="text-muted-foreground">
              {weekLabel(i)}
              <span className="text-xs">
                {" "}
                · in {formatNaira(w.inflow)} · out {formatNaira(w.outflow)}
              </span>
            </span>
            <span
              className={`font-semibold tabular-nums ${
                Number(w.net) < 0 ? "text-amber-800 dark:text-amber-300" : ""
              }`}
            >
              {formatNaira(w.net)}
            </span>
          </div>
        ))}
        {(group.overdueInflow.count > 0 || group.overdueOutflow.count > 0) && (
          <p className="text-xs text-muted-foreground">
            Outside these weeks: {formatNaira(group.overdueInflow.amount)}{" "}
            expected but already late,{" "}
            {formatNaira(group.overdueOutflow.amount)} in bills already overdue.
          </p>
        )}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {position.note} {group.currency} only
          {position.groups.length > 1 ? " (other currencies not shown)" : ""}.
        </p>
      </CardContent>
    </Card>
  );
}

// Cash-flow outlook (round-10 idea #1): expected inflows by week, projected
// server-side from each buyer's own payment rhythm (falling back to due
// dates / standard terms). Deterministic, renders only when there is money
// outstanding.
export function CashflowCard({ clientPartyId }: { clientPartyId: string }) {
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
          Projected from each customer&apos;s own payment history where we have
          one, otherwise due dates. {group.currency} only
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
export function ChaseListCard({ clientPartyId }: { clientPartyId: string }) {
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
  // Reminder effectiveness (round 16): what past reminders actually did,
  // joined from the chase ladder and observed payments. Shown only once the
  // share clears its server-side sample floor.
  const { data: effectiveness } = useGetChaseEffectiveness(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetChaseEffectivenessQueryKey({ clientPartyId }),
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
          {effectiveness && effectiveness.settledWithinShare != null && (
            <span data-testid="chase-effectiveness">
              {" "}
              Of your past reminders,{" "}
              {Math.round(effectiveness.settledWithinShare * 100)}% were
              followed by payment within {effectiveness.withinDays} days
              {effectiveness.medianDaysReminderToSettle != null
                ? ` (typically ${Math.round(effectiveness.medianDaysReminderToSettle)} days after the reminder)`
                : ""}
              .
            </span>
          )}
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

type DashboardView = "today" | "money" | "compliance" | "clerk";

export function Dashboard() {
  usePageTitle("Dashboard");
  const [view, setView] = useState<DashboardView>("today");
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

  const agedReceivableCount =
    receivables?.groups.reduce(
      (total, group) => total + group.buckets.days90plus.count,
      0,
    ) ?? 0;
  const workItems: WorkQueueItem[] = [];
  if (summary?.atRiskCount) {
    workItems.push({
      id: "at-risk-invoices",
      title: `${summary.atRiskCount} invoice${summary.atRiskCount === 1 ? " is" : "s are"} at risk`,
      description: "The statutory submission window is closing or has passed.",
      tone: "critical",
      icon: <AlertTriangle className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="destructive">
          <Link href="/calendar">Review risk</Link>
        </Button>
      ),
    });
  }
  if (summary?.failedCount) {
    workItems.push({
      id: "failed-submissions",
      title: `${summary.failedCount} failed submission${summary.failedCount === 1 ? "" : "s"}`,
      description:
        "Review the rejection reason before sending the invoice again.",
      tone: "critical",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Resolve</Link>
        </Button>
      ),
    });
  }
  if (summary?.draftCount) {
    workItems.push({
      id: "draft-invoices",
      title: `${summary.draftCount} draft invoice${summary.draftCount === 1 ? " needs" : "s need"} completion`,
      description: "Finish, validate and submit the paper already in progress.",
      tone: "warning",
      icon: <FileText className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/invoices">Open drafts</Link>
        </Button>
      ),
    });
  }
  if (agedReceivableCount > 0) {
    workItems.push({
      id: "aged-receivables",
      title: `${agedReceivableCount} receivable${agedReceivableCount === 1 ? " is" : "s are"} more than 90 days old`,
      description: "Prioritize the oldest balances in the collection queue.",
      tone: "warning",
      icon: <Wallet className="size-4" aria-hidden="true" />,
      action: (
        <Button size="sm" variant="outline" onClick={() => setView("money")}>
          Open money view
        </Button>
      ),
    });
  }
  if (summary?.nextDeadline) {
    workItems.push({
      id: `deadline-${summary.nextDeadline.id}`,
      title: summary.nextDeadline.title,
      description: `Due ${formatDate(summary.nextDeadline.dueDate)}.`,
      tone:
        summary.nextDeadline.severity === "critical"
          ? "critical"
          : summary.nextDeadline.severity === "warning"
            ? "warning"
            : "info",
      icon: <CalendarCheck className="size-4" aria-hidden="true" />,
      action: (
        <Button asChild size="sm" variant="outline">
          <Link href="/calendar">View deadline</Link>
        </Button>
      ),
    });
  }

  const dashboardViews: Array<{
    value: DashboardView;
    label: string;
    count?: number;
  }> = [
    { value: "today", label: "Today", count: workItems.length },
    { value: "money", label: "Money", count: agedReceivableCount },
    {
      value: "compliance",
      label: "Compliance",
      count: summary?.upcomingDeadlineCount ?? 0,
    },
  ];
  if (canAskClerk) {
    dashboardViews.push({ value: "clerk", label: "Clerk" });
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Business command centre"
        title="Compliance overview"
        description="Prioritized work, money movement and filing readiness for this business."
        actions={
          <Button asChild>
            <Link href="/invoices/new">New invoice</Link>
          </Button>
        }
      />

      <RequireClientScope thing="compliance summary">
        {isLoading ? (
          <DashboardSkeleton />
        ) : isError ? (
          <QueryError
            thing="your compliance summary"
            onRetry={() => refetch()}
          />
        ) : (
          <>
            <MetricStrip label="Business compliance summary">
              <Metric
                label="Pending invoices"
                value={String(summary?.pendingCount ?? 0)}
                detail="Awaiting stamp"
                icon={<Clock className="size-4" aria-hidden="true" />}
                tone={(summary?.pendingCount ?? 0) > 0 ? "info" : "default"}
              />
              <Metric
                label="Stamped & valid"
                value={String(summary?.stampedCount ?? 0)}
                detail={`${formatNaira(summary?.stampedValue)} total value`}
                icon={<CheckCircle className="size-4" aria-hidden="true" />}
                tone="positive"
              />
              <Metric
                label="Drafts"
                value={String(summary?.draftCount ?? 0)}
                detail="Needs completion"
                icon={<FileText className="size-4" aria-hidden="true" />}
                tone={(summary?.draftCount ?? 0) > 0 ? "warning" : "default"}
              />
              <Metric
                label="At risk"
                value={String(summary?.atRiskCount ?? 0)}
                detail="Needs attention"
                icon={<AlertTriangle className="size-4" aria-hidden="true" />}
                tone={(summary?.atRiskCount ?? 0) > 0 ? "critical" : "default"}
              />
            </MetricStrip>

            <SegmentedControl<DashboardView>
              items={dashboardViews}
              value={view}
              onChange={setView}
              label="Dashboard view"
            />

            {view === "today" && (
              <WorkQueue
                title="What needs attention"
                description="Ordered by statutory risk, failed work and cash collection age."
                items={workItems}
                emptyTitle="Today is clear"
                emptyDescription="There are no urgent submissions, failures or aged receivables."
              />
            )}

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              {view === "today" && (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2">
                        <Activity className="w-5 h-5" aria-hidden="true" />{" "}
                        Recent activity
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {summary?.recentActivity &&
                      summary.recentActivity.length > 0 ? (
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
                        <Clock className="w-5 h-5" aria-hidden="true" /> Next
                        deadline
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

                  {me?.clientPartyId && (
                    <MonthEndCloseCard clientPartyId={me.clientPartyId} />
                  )}
                </>
              )}

              {(view === "today" || view === "money") && (
                <ReceivablesCard
                  summary={receivables}
                  isLoading={receivablesLoading}
                  isError={receivablesError}
                  clientPartyId={me?.clientPartyId || ""}
                  totalInvoices={summary?.totalInvoices}
                  onRetry={() => refetchReceivables()}
                />
              )}

              {view === "money" && me?.clientPartyId && (
                <PayablesCard clientPartyId={me.clientPartyId} />
              )}

              {view === "clerk" && canAskClerk && <ClerkDigestCard />}

              {view === "compliance" &&
                canSeeStatement &&
                me?.clientPartyId && (
                  <>
                    <ClientStatementCard clientPartyId={me.clientPartyId} />
                    <AdvisoryBriefCard clientPartyId={me.clientPartyId} />
                  </>
                )}

              {view === "compliance" && me?.clientPartyId && (
                <PenaltyExposureCard clientPartyId={me.clientPartyId} />
              )}

              {view === "clerk" && me?.clientPartyId && (
                <ClerkActionsCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <UnbilledIncomeCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <UnmatchedCreditsCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <CashflowCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <NetPositionCard clientPartyId={me.clientPartyId} />
              )}

              {view === "money" && me?.clientPartyId && (
                <ChaseListCard clientPartyId={me.clientPartyId} />
              )}
            </div>
          </>
        )}
      </RequireClientScope>
    </div>
  );
}
