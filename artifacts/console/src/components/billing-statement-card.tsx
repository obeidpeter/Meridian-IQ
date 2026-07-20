import { useEffect, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import {
  useGetBillingStatement,
  getGetBillingStatementQueryKey,
  getExportBillingStatementCsvUrl,
} from "@workspace/api-client-react";
import type {
  BillingStatement,
  BillingStatementFee,
  BillingStatementTier,
  BillingStatementUsage,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { Download } from "lucide-react";
import { formatNaira } from "@/lib/format";
import { monthCsvFilename, triggerDownload } from "@/lib/download";

// Monthly platform-billing statement: tier, metered usage and the computed
// fee for a closed month — deterministic server-side, nothing stored.
// Render-on-success is the INITIAL gate only, like the VAT pack beside it: a
// 403 for roles without billing scope (or a 404 from an older server build)
// hides the whole section. Once a statement has loaded the card stays
// mounted across month switches — a failed month fetch shows an inline
// error + retry (the prefsCardState precedent), never a vanished card.

/** One line describing the plan the fee is computed from. */
export function tierSummary(tier: BillingStatementTier): string {
  const parts = [
    `${tier.name} — ${formatNaira(tier.monthlyPrice)}/month`,
    `${tier.includedInvoices.toLocaleString()} accepted invoice(s) included`,
    `${formatNaira(tier.overagePrice)} per extra`,
  ];
  if (tier.clerkMonthlyTokens != null) {
    parts.push(
      `${tier.clerkMonthlyTokens.toLocaleString()} Clerk tokens/month`,
    );
  }
  return parts.join(" · ");
}

/** The Clerk usage line: total tokens with the call count alongside. */
export function clerkUsageLine(usage: BillingStatementUsage): string {
  return `${usage.clerkTokens.toLocaleString()} tokens across ${usage.clerkCalls.toLocaleString()} call(s)`;
}

/**
 * The overage row reads as the em-dash sentinel when the month stayed inside
 * the plan — a ₦0.00 line would suggest an overage machinery at work.
 */
export function overageLine(fee: BillingStatementFee): string {
  return fee.overageInvoices > 0
    ? `${formatNaira(fee.overage)} (${fee.overageInvoices.toLocaleString()} invoice(s) over the plan)`
    : "—";
}

export type BillingCardState = "hidden" | "data" | "loading" | "error";

/**
 * What the card renders. Before the first successful load there is nothing
 * to show ("hidden" — the initial render-on-success gate; a 403/404 keeps
 * the section away). Once a statement is held, a month switch renders the
 * last-good statement with a loading hint, and a failed month fetch renders
 * it with an inline error + retry — the card never unmounts on either.
 */
export function billingCardState(args: {
  hasStatement: boolean;
  isError: boolean;
  isFetching: boolean;
}): BillingCardState {
  if (!args.hasStatement) return "hidden";
  if (args.isError) return "error";
  return args.isFetching ? "loading" : "data";
}

export function BillingStatementCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const query = useGetBillingStatement(params, {
    query: {
      queryKey: getGetBillingStatementQueryKey(params),
      retry: false,
      // A month switch changes the query key; keep the previous month's
      // statement as placeholder so the card body never blanks mid-switch.
      placeholderData: keepPreviousData,
    },
  });
  const [showPurposes, setShowPurposes] = useState(false);
  // Last successfully loaded statement — the fallback the body renders from
  // when a month fetch FAILS (query.data is gone by then; the placeholder
  // only bridges the pending phase).
  const [lastGood, setLastGood] = useState<BillingStatement | null>(null);
  useEffect(() => {
    if (query.isSuccess && query.data) setLastGood(query.data);
  }, [query.isSuccess, query.data]);

  const statement = query.data ?? lastGood;
  const state = billingCardState({
    hasStatement: !!statement,
    isError: query.isError,
    isFetching: query.isFetching,
  });
  if (state === "hidden" || !statement) return null;
  const exportHref = getExportBillingStatementCsvUrl({
    month: statement.monthStart,
  });
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-billing-statement"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Billing statement</span>
          <span className="flex items-center gap-2">
            <Select
              value={month ?? statement.monthStart}
              onValueChange={(m) => {
                setMonth(m);
                setShowPurposes(false);
              }}
            >
              <SelectTrigger
                className="h-8 w-44 text-xs"
                data-testid="select-billing-month"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statement.months.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                triggerDownload(
                  exportHref,
                  monthCsvFilename("billing-statement", statement.monthStart),
                )
              }
              data-testid="button-billing-csv"
            >
              <Download className="w-4 h-4 mr-1" aria-hidden="true" /> CSV
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state === "error" ? (
          // The month fetch failed: keep the card (and its month picker) so
          // the partner can retry or switch back, instead of the whole
          // section silently vanishing.
          <QueryError
            thing="that month's billing statement"
            onRetry={() => void query.refetch()}
          />
        ) : (
          <>
            {state === "loading" && (
              <p
                className="text-xs text-muted-foreground"
                role="status"
                data-testid="text-billing-loading"
              >
                Loading the selected month…
              </p>
            )}
            <p className="text-sm" data-testid="text-billing-tier">
              {tierSummary(statement.tier)}
            </p>

            <div className="divide-y text-sm" data-testid="billing-usage">
              <div className="flex items-baseline justify-between gap-4 py-2">
                <span>Accepted invoices</span>
                <span
                  className="tabular-nums text-right"
                  data-testid="text-billing-accepted"
                >
                  {statement.usage.acceptedInvoices.toLocaleString()}
                  <span className="block text-xs text-muted-foreground">
                    {statement.usage.submissionAttempts.toLocaleString()}{" "}
                    submission attempt(s)
                  </span>
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <span>
                  Clerk usage
                  {statement.usage.byPurpose.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-2 h-6 px-2 text-xs"
                      onClick={() => setShowPurposes((o) => !o)}
                      aria-expanded={showPurposes}
                      aria-controls="billing-purposes-list"
                      data-testid="button-billing-purposes"
                    >
                      {showPurposes ? "Hide purposes" : "By purpose"}
                    </Button>
                  )}
                </span>
                <span
                  className="tabular-nums text-right"
                  data-testid="text-billing-clerk"
                >
                  {clerkUsageLine(statement.usage)}
                </span>
              </div>
              {showPurposes && (
                <div
                  className="py-2"
                  id="billing-purposes-list"
                  data-testid="list-billing-purposes"
                >
                  {statement.usage.byPurpose.map((p) => (
                    <div
                      key={p.purpose}
                      className="flex items-baseline justify-between gap-4 py-0.5 text-xs text-muted-foreground"
                      data-testid={`row-billing-purpose-${p.purpose}`}
                    >
                      <span className="font-mono">{p.purpose}</span>
                      <span className="tabular-nums">
                        {p.tokens.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-baseline justify-between gap-4 py-2">
                <span>Base fee</span>
                <span
                  className="tabular-nums text-right"
                  data-testid="text-billing-base"
                >
                  {formatNaira(statement.fee.base)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2">
                <span>Overage</span>
                <span
                  className="tabular-nums text-right"
                  data-testid="text-billing-overage"
                >
                  {overageLine(statement.fee)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 py-2 font-semibold">
                <span>Total — {statement.monthLabel}</span>
                <span
                  className="tabular-nums text-right"
                  data-testid="text-billing-total"
                >
                  {formatNaira(statement.fee.total)}
                </span>
              </div>
            </div>

            <p
              className="text-xs text-muted-foreground"
              data-testid="text-billing-note"
            >
              {statement.note}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
