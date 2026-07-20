import { useEffect, useState } from "react";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  useGetBillingStatement,
  getGetBillingStatementQueryKey,
  getExportBillingStatementCsvUrl,
  useListPaymentIntents,
  useCreatePaymentIntent,
  getListPaymentIntentsQueryKey,
} from "@workspace/api-client-react";
import type {
  BillingStatement,
  BillingStatementFee,
  BillingStatementTier,
  BillingStatementUsage,
  PaymentIntent,
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
import { Download, ExternalLink } from "lucide-react";
import { errorStatus } from "@/lib/errors";
import { formatNaira, humanize, pillClasses } from "@/lib/format";
import type { BadgeTone } from "@/lib/format";
import { monthCsvFilename, triggerDownload } from "@/lib/download";

// Monthly platform-billing statement: tier, metered usage and the computed
// fee for a closed month — deterministic server-side, nothing stored.
// Render-on-success is the INITIAL gate only, like the VAT pack beside it: a
// 403 for roles without billing scope (or a 404 from an older server build)
// hides the whole section. Once a statement has loaded the card stays
// mounted across month switches — a failed month fetch shows an inline
// error + retry (the prefsCardState precedent), never a vanished card.
// Payments (contract 0.41.0): the card can also RECORD a payment intent for
// the selected month — the amount is computed server-side from the same fee
// core the card renders, so what the firm pays can never disagree with what
// it was shown — and lists the firm's intents with their provider status.

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

/**
 * Friendly copy for a failed "record payment intent". The two 4xx answers
 * the server gives deliberately (payments.ts) get their own words: 409 is
 * the duplicate-payment wall (a live intent already exists for the month),
 * 400 is the zero-fee refusal (nothing to collect). Anything else is a
 * plain retryable failure.
 */
export function paymentErrorCopy(status: number | undefined): string {
  if (status === 409)
    return "A payment for this month is already in motion — see the payments below.";
  if (status === 400)
    return "There's nothing to collect for this month — the computed fee is zero.";
  return "Could not record the payment intent. Try again.";
}

// Provider lifecycle of a payment intent: pending until the confirmation
// webhook settles it one way or the other.
const INTENT_LABELS: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const INTENT_TONES: Record<string, BadgeTone> = {
  pending: "amber",
  confirmed: "emerald",
  failed: "red",
  cancelled: "slate",
};

export function intentStatusLabel(status: string): string {
  return INTENT_LABELS[status] ?? humanize(status);
}

export function intentBadgeClasses(status: string): string {
  return pillClasses(INTENT_TONES[status] ?? "slate");
}

/**
 * Month label for an intent row, resolved through the statement's own month
 * option list (intents can only ever target those closed months — the
 * server enforces it), falling back to the raw YYYY-MM-01 for anything the
 * list no longer carries.
 */
export function intentMonthLabel(
  monthStart: string,
  months: { value: string; label: string }[],
): string {
  return months.find((m) => m.value === monthStart)?.label ?? monthStart;
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
  const queryClient = useQueryClient();
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

  // Payment intents: render-on-success like the card itself (the payments
  // routes carry their own scope; a 403/404 hides the section, never breaks
  // the card).
  const intentsQuery = useListPaymentIntents({
    query: { queryKey: getListPaymentIntentsQueryKey(), retry: false },
  });
  const createIntent = useCreatePaymentIntent();
  const [paymentError, setPaymentError] = useState<string | null>(null);
  // The intent the last click created — carries the checkout link the firm
  // follows to actually pay.
  const [recorded, setRecorded] = useState<PaymentIntent | null>(null);

  const recordPayment = (monthStart: string) => {
    setPaymentError(null);
    setRecorded(null);
    createIntent.mutate(
      { data: { monthStart } },
      {
        onSuccess: (intent) => {
          setRecorded(intent);
          void queryClient.invalidateQueries({
            queryKey: getListPaymentIntentsQueryKey(),
          });
        },
        onError: (err) => setPaymentError(paymentErrorCopy(errorStatus(err))),
      },
    );
  };

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
                // Payment feedback describes the month it was recorded for —
                // clear it so it never captions a different month's numbers.
                setPaymentError(null);
                setRecorded(null);
              }}
            >
              <SelectTrigger
                className="h-8 w-44 text-xs"
                aria-label="Billing month"
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

            {intentsQuery.isSuccess && (
              <div
                className="space-y-2 border-t pt-3"
                data-testid="section-billing-payments"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">Payments</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={createIntent.isPending}
                    onClick={() => recordPayment(statement.monthStart)}
                    data-testid="button-record-payment"
                  >
                    {createIntent.isPending
                      ? "Recording…"
                      : `Record payment intent — ${statement.monthLabel}`}
                  </Button>
                </div>
                {paymentError && (
                  <p
                    className="text-sm text-destructive"
                    role="alert"
                    data-testid="text-payment-error"
                  >
                    {paymentError}
                  </p>
                )}
                {recorded && (
                  <p
                    className="text-sm text-emerald-700 dark:text-emerald-400"
                    role="status"
                    data-testid="text-payment-recorded"
                  >
                    Recorded {formatNaira(recorded.amountNgn)} for{" "}
                    {intentMonthLabel(recorded.monthStart, statement.months)}.
                    {recorded.checkoutUrl && (
                      <>
                        {" "}
                        <a
                          href={recorded.checkoutUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                          data-testid="link-recorded-checkout"
                        >
                          Open checkout
                          <ExternalLink
                            className="size-3.5"
                            aria-hidden="true"
                          />
                          <span className="sr-only">(opens in a new tab)</span>
                        </a>
                      </>
                    )}
                  </p>
                )}
                {(intentsQuery.data ?? []).length === 0 ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="text-no-payments"
                  >
                    No payments recorded yet — recording an intent computes
                    the month&apos;s fee server-side and opens a checkout.
                  </p>
                ) : (
                  <ul className="divide-y" data-testid="list-payment-intents">
                    {(intentsQuery.data ?? []).map((intent) => (
                      <li
                        key={intent.id}
                        className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                        data-testid={`row-payment-${intent.id}`}
                      >
                        <span className="flex items-center gap-2">
                          <span>
                            {intentMonthLabel(
                              intent.monthStart,
                              statement.months,
                            )}
                          </span>
                          <span className={intentBadgeClasses(intent.status)}>
                            {intentStatusLabel(intent.status)}
                          </span>
                        </span>
                        <span className="flex items-center gap-3">
                          {intent.status === "pending" &&
                            intent.checkoutUrl && (
                              <a
                                href={intent.checkoutUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-2"
                                data-testid={`link-checkout-${intent.id}`}
                              >
                                Checkout
                                <ExternalLink
                                  className="size-3"
                                  aria-hidden="true"
                                />
                                <span className="sr-only">
                                  (opens in a new tab)
                                </span>
                              </a>
                            )}
                          <span className="tabular-nums">
                            {formatNaira(intent.amountNgn)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
