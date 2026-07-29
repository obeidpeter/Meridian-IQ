import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
  useGetActionProposals,
  getGetActionProposalsQueryKey,
  useExecuteAction,
  getGetActionDecisionsQueryKey,
  getListInvoicesQueryKey,
} from "@workspace/api-client-react";
import type {
  ActionProposal,
  CashflowBucket,
  ClerkActionDecision,
  PayablesSummaryGroupsItem,
  ReceivablesBucket,
  ReceivablesSummary,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Download,
  FileText,
  Activity,
  Send,
  Sparkles,
  CalendarCheck,
  Receipt,
  Wallet,
} from "lucide-react";
import { Link } from "wouter";
import {
  formatAmount,
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

/**
 * The payables card keeps three visual buckets (mirroring the receivables
 * card's at-a-glance shape): Overdue, Due this week (dueWeeks[0]), and
 * everything beyond — the remaining weekly buckets folded into `later`.
 * Exported for the unit tests.
 */
export function dueLaterBucket(group: PayablesSummaryGroupsItem): CashflowBucket {
  const rest = group.dueWeeks.slice(1);
  const amount =
    rest.reduce((sum, w) => sum + Number(w.amount), 0) +
    Number(group.later.amount);
  const count =
    rest.reduce((sum, w) => sum + w.count, 0) + group.later.count;
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
            <AgingBucketRow label="Due later" bucket={dueLaterBucket(primary)} />
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
                  Usually about {formatAmount(a.medianAmount, a.currency)}{" "}
                  every ~{a.medianGapDays} days · last invoiced{" "}
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
function MonthEndCloseCard({ clientPartyId }: { clientPartyId: string }) {
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
  if (!isSuccess || !close) return null;
  return (
    <Card data-testid="month-end-close">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck className="w-5 h-5" aria-hidden="true" /> Month-end
          close
          {close.attentionCount > 0 ? (
            <span
              className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
              data-testid="text-close-attention-count"
            >
              {close.attentionCount} to review
            </span>
          ) : (
            <span
              className="ml-auto rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
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
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {close.note}
        </p>
      </CardContent>
    </Card>
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
              <p key={s.invoiceId} data-testid={`penalty-invoice-${s.invoiceId}`}>
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

const TARGET_DISPLAY_CAP = 8;

const OUTCOME_LABELS: Record<string, string> = {
  submitted: "Submitted",
  invalid: "Needs fixing",
  skipped_not_eligible: "Skipped",
  failed: "Failed",
};

// Proposed actions (round 21): Clerk assembles the batch from the same
// checks that power the cards above; NOTHING runs until the owner approves.
// Approval executes through the ordinary submission path — validation,
// consent, any approval policy — and every target is re-checked at that
// moment. Renders only when the clerk_actions flag is on for the firm AND a
// proposal exists (a dark flag answers an empty list, so the card hides).
function ClerkActionsCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const execute = useExecuteAction();
  // `decision === null` is the confirmation step; a decision switches the
  // dialog to the results view (the bulk-submit dialog's shape).
  const [confirming, setConfirming] = useState<ActionProposal | null>(null);
  const [decision, setDecision] = useState<ClerkActionDecision | null>(null);
  const { data: proposals, isSuccess } = useGetActionProposals(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetActionProposalsQueryKey({ clientPartyId }),
        staleTime: 60_000,
        retry: false,
      },
    },
  );
  // The dialog must survive the proposals list emptying: after a full
  // batch submits, the refetched list is [] and an early return would
  // unmount the OPEN results view mid-read (review F1) — so the card stays
  // mounted while the dialog is up, and the proposals refetch itself is
  // deferred to closeDialog.
  const dialogOpen = confirming !== null || decision !== null;
  if (
    !isSuccess ||
    !proposals ||
    (proposals.actions.length === 0 && !dialogOpen)
  ) {
    return null;
  }

  const runAction = async (action: ActionProposal) => {
    try {
      const res = await execute.mutateAsync({
        data: {
          kind: action.kind,
          invoiceIds: action.targets.map((t) => t.invoiceId),
          clientPartyId,
        },
      });
      setDecision(res.decision);
      // Not awaited: a background refetch rejection must not surface as a
      // false "action failed" error after the batch already ran. The
      // no-args keys prefix-match every param variant. The proposals and
      // decisions queries are deliberately NOT here — see closeDialog.
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
      queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetReceivablesSummaryQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetPenaltyExposureQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetMonthEndCloseQueryKey(),
      });
    } catch (e) {
      toast({
        title: "Action failed",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  const closeDialog = () => {
    // A batch in flight cannot be cancelled from here — keep the dialog up
    // so its result is always shown.
    if (execute.isPending) return;
    if (decision !== null) {
      queryClient.invalidateQueries({
        queryKey: getGetActionProposalsQueryKey(),
      });
      queryClient.invalidateQueries({
        queryKey: getGetActionDecisionsQueryKey(),
      });
    }
    setConfirming(null);
    setDecision(null);
  };

  return (
    <Card data-testid="clerk-actions">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="w-5 h-5" aria-hidden="true" /> Clerk suggests
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {proposals.actions.map((action) => (
          <div key={action.kind} className="space-y-2" data-testid={`action-${action.kind}`}>
            <p className="font-medium">{action.title}</p>
            <p className="text-sm text-muted-foreground">{action.why}</p>
            <div className="space-y-1 text-xs text-muted-foreground">
              {action.targets.slice(0, TARGET_DISPLAY_CAP).map((t) => (
                <p key={t.invoiceId} data-testid={`action-target-${t.invoiceId}`}>
                  {t.invoiceNumber} · issued {formatDate(t.issueDate)} ·{" "}
                  {t.daysOverdue} day{t.daysOverdue === 1 ? "" : "s"} past the
                  window
                  {t.grandTotal
                    ? ` · ${formatAmount(t.grandTotal, t.currency)}`
                    : ""}
                </p>
              ))}
              {action.targets.length > TARGET_DISPLAY_CAP && (
                <p>…and {action.targets.length - TARGET_DISPLAY_CAP} more.</p>
              )}
              {action.truncated && (
                <p>
                  Showing the oldest {action.targets.length} of{" "}
                  {action.targetCount} — approve this batch, then come back for
                  the rest.
                </p>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => setConfirming(action)}
              disabled={execute.isPending}
              data-testid="button-approve-action"
            >
              <Send className="w-4 h-4 mr-2" aria-hidden="true" />
              Review &amp; approve
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground pt-3 border-t">
          {proposals.note}
        </p>
      </CardContent>
      <Dialog open={!!confirming} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {decision === null ? (
            <>
              <DialogHeader>
                <DialogTitle>Approve: {confirming?.title}</DialogTitle>
                <DialogDescription>
                  This submits {confirming?.targets.length} invoice
                  {confirming?.targets.length === 1 ? "" : "s"} to the
                  e-invoicing rails through the ordinary path — validation,
                  consent and any approval policy all apply. Each invoice is
                  re-checked at this moment; anything already submitted or no
                  longer overdue is skipped, and the decision is recorded under
                  your name.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={closeDialog}
                  disabled={execute.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => confirming && runAction(confirming)}
                  disabled={execute.isPending}
                  data-testid="button-confirm-action"
                >
                  {execute.isPending
                    ? "Submitting…"
                    : `Approve ${confirming?.targets.length ?? 0} invoice${
                        confirming?.targets.length === 1 ? "" : "s"
                      }`}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Batch result</DialogTitle>
                <DialogDescription data-testid="text-action-outcome">
                  {decision.executedCount} submitted · {decision.failedCount}{" "}
                  need attention · {decision.skippedCount} skipped.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1 text-sm">
                {decision.targets.map((t) => (
                  <p
                    key={t.invoiceId}
                    className="flex justify-between gap-3"
                    data-testid={`outcome-${t.invoiceId}`}
                  >
                    <span className="truncate">{t.invoiceNumber}</span>
                    <span
                      className={
                        t.outcome === "submitted"
                          ? "text-emerald-700 dark:text-emerald-400"
                          : t.outcome === "skipped_not_eligible"
                            ? "text-muted-foreground"
                            : "text-amber-700 dark:text-amber-400"
                      }
                    >
                      {OUTCOME_LABELS[t.outcome] ?? t.outcome}
                      {t.error ? ` — ${t.error}` : ""}
                    </span>
                  </p>
                ))}
              </div>
              <DialogFooter>
                <Button onClick={closeDialog} data-testid="button-close-action">
                  Done
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
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
  const weekLabel = (i: number) =>
    i === 0 ? "This week" : i === 1 ? "Next week" : `Week +${i}`;
  return (
    <Card data-testid="net-position">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="w-5 h-5" aria-hidden="true" /> Net cash
          position
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
                Number(w.net) < 0
                  ? "text-amber-800 dark:text-amber-300"
                  : ""
              }`}
            >
              {formatNaira(w.net)}
            </span>
          </div>
        ))}
        {(group.overdueInflow.count > 0 || group.overdueOutflow.count > 0) && (
          <p className="text-xs text-muted-foreground">
            Outside these weeks: {formatNaira(group.overdueInflow.amount)}{" "}
            expected but already late, {formatNaira(group.overdueOutflow.amount)}{" "}
            in bills already overdue.
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

              {me?.clientPartyId && (
                <PayablesCard clientPartyId={me.clientPartyId} />
              )}

              {canAskClerk && <ClerkDigestCard />}

              {canSeeStatement && me?.clientPartyId && (
                <ClientStatementCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <MonthEndCloseCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <PenaltyExposureCard clientPartyId={me.clientPartyId} />
              )}

              {me?.clientPartyId && (
                <ClerkActionsCard clientPartyId={me.clientPartyId} />
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
                <NetPositionCard clientPartyId={me.clientPartyId} />
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
