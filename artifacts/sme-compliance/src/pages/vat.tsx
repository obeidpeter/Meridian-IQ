import { Link } from "wouter";
import { useState } from "react";
import {
  useGetMe,
  useGetClientVatPosition,
  getGetClientVatPositionQueryKey,
  getExportVatPositionCsvUrl,
  useGetComplianceCalendar,
  getGetComplianceCalendarQueryKey,
} from "@workspace/api-client-react";
import type {
  GetClientVatPositionParams,
  ClientVatPosition as VatPositionPayload,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { Download, Percent } from "lucide-react";
import {
  formatLagosDate,
  formatNaira,
  severityBadgeClasses,
} from "@/lib/format";

// Monthly VAT position (contract 0.45.0): output VAT from the client's own
// issued documents against input VAT from their captured supplier bills, one
// Lagos month at a time. Everything is computed server-side — this page only
// renders the payload; the verified/unverified split is the compliance story
// (only stamp-verified input VAT is defensible in an audit).

// "2026-06-01" -> "June 2026" for the month picker and headings.
const VAT_MONTHS = [
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

export function vatMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${VAT_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * The CSV export href: a plain same-origin navigation — auth rides the
 * session cookie and the endpoint answers with a Content-Disposition
 * attachment. Pinned to the loaded month so the file always matches what is
 * on screen.
 */
export function vatCsvHref(clientPartyId: string, monthStart: string): string {
  return getExportVatPositionCsvUrl({ clientPartyId, month: monthStart });
}

/**
 * The foreign-exchange exclusion warning, or null when nothing was excluded.
 * Documents in a foreign currency with no exchange rate cannot be folded
 * into naira totals honestly, so the server leaves them out and says so.
 */
export function fxExcludedLine(count: number): string | null {
  if (count <= 0) return null;
  return `${count} foreign-currency document${count === 1 ? "" : "s"} without an exchange rate ${
    count === 1 ? "is" : "are"
  } excluded from these naira totals.`;
}

/** "2026-08-01" -> "2026-07-01" (Lagos months are plain calendar months). */
export function prevMonthStart(monthStart: string): string {
  const [y, m] = monthStart.split("-").map(Number);
  return m === 1
    ? `${y - 1}-12-01`
    : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}

/**
 * One sentence placing the displayed month against the one before it, or
 * null when the previous month has nothing to compare against (no issued
 * documents and no captured bills). Pure so the wording is unit-testable.
 */
export function vatComparisonLine(
  current: VatPositionPayload,
  previous: VatPositionPayload,
): string | null {
  if (previous.outputInvoiceCount === 0 && previous.billCount === 0) {
    return null;
  }
  const phrase = (label: string, cur: string, prev: string) => {
    const diff = Number(cur) - Number(prev);
    if (diff === 0) return `${label} is unchanged`;
    return `${label} is ${formatNaira(Math.abs(diff).toFixed(2))} ${
      diff > 0 ? "higher" : "lower"
    }`;
  };
  return `Compared with ${previous.monthLabel}: ${phrase(
    "net VAT",
    current.netVat,
    previous.netVat,
  )}, ${phrase(
    "defensible net",
    current.defensibleNetVat,
    previous.defensibleNetVat,
  )}.`;
}

export type VatRow = {
  key: string;
  label: string;
  value: string;
  testId: string;
  /** Indented "of which…" detail under the input VAT line. */
  sub?: boolean;
  /** The two bottom-line rows render bold. */
  strong?: boolean;
};

/** The summary rows, in reading order — exported for the unit tests. */
export function vatRows(p: VatPositionPayload): VatRow[] {
  return [
    {
      key: "output",
      label: `Output VAT — ${p.outputInvoiceCount} document${
        p.outputInvoiceCount === 1 ? "" : "s"
      } issued`,
      value: formatNaira(p.outputVat),
      testId: "text-vat-output",
    },
    {
      key: "input",
      label: `Input VAT — ${p.billCount} supplier bill${
        p.billCount === 1 ? "" : "s"
      }`,
      value: formatNaira(p.inputVat),
      testId: "text-vat-input",
    },
    {
      key: "input-verified",
      label: "of which stamp-verified",
      value: formatNaira(p.inputVatVerified),
      testId: "text-vat-input-verified",
      sub: true,
    },
    {
      key: "input-unverified",
      label: "of which unverified",
      value: formatNaira(p.inputVatUnverified),
      testId: "text-vat-input-unverified",
      sub: true,
    },
    {
      key: "net",
      label: "Net VAT position (output − input)",
      value: formatNaira(p.netVat),
      testId: "text-vat-net",
      strong: true,
    },
    {
      key: "defensible",
      label: "Defensible net (verified input only)",
      value: formatNaira(p.defensibleNetVat),
      testId: "text-vat-defensible",
      strong: true,
    },
  ];
}

export function Vat() {
  usePageTitle("VAT position");
  const { data: me } = useGetMe();
  const clientPartyId = me?.clientPartyId || "";
  // undefined = the server's default (current Lagos month); a picked month
  // rides the query string.
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params: GetClientVatPositionParams = month
    ? { clientPartyId, month }
    : { clientPartyId };

  const {
    data: position,
    isLoading,
    isError,
    refetch,
  } = useGetClientVatPosition(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetClientVatPositionQueryKey(params),
    },
  });

  // The month before the displayed one, fetched only when the server's own
  // month list carries it — the comparison line is a side-by-side aid, so a
  // missing previous month simply means no line, never a guessed figure.
  const prevMonth = position ? prevMonthStart(position.monthStart) : null;
  const prevKnown =
    !!prevMonth && !!position && position.months.includes(prevMonth);
  const prevParams: GetClientVatPositionParams = {
    clientPartyId,
    month: prevMonth ?? "",
  };
  const { data: previous } = useGetClientVatPosition(prevParams, {
    query: {
      enabled: !!clientPartyId && prevKnown,
      queryKey: getGetClientVatPositionQueryKey(prevParams),
    },
  });
  const comparison =
    position && previous && prevKnown && previous.monthStart === prevMonth
      ? vatComparisonLine(position, previous)
      : null;

  // The statutory due date lives on the compliance calendar, not in the VAT
  // position payload — the server owns the day (Filing Desk), this page only
  // names it. Progressive: if the calendar fetch fails the line is absent.
  const { data: calendarDeadlines } = useGetComplianceCalendar(
    { clientPartyId },
    {
      query: {
        enabled: !!clientPartyId,
        queryKey: getGetComplianceCalendarQueryKey({ clientPartyId }),
      },
    },
  );
  const vatDeadline =
    calendarDeadlines?.find((d) => d.kind === "vat_return") ?? null;

  const fxLine = position ? fxExcludedLine(position.excludedForFx) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="VAT position"
        description={
          <>
            Output VAT from your issued documents against input VAT from your
            supplier bills — one month at a time.{" "}
            <Link
              href="/help#vat"
              className="font-bold text-teal-800 underline underline-offset-2"
              data-testid="link-help-vat"
            >
              How this is calculated
            </Link>
          </>
        }
      />

      <RequireClientScope thing="VAT position">
        {isLoading ? (
          <SkeletonList count={4} itemClassName="h-16" />
        ) : isError ? (
          <QueryError thing="your VAT position" onRetry={() => refetch()} />
        ) : !position ? null : (
          <Card data-testid="card-vat-position">
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
                <span className="flex items-center gap-2">
                  <Percent
                    className="w-4 h-4 text-primary"
                    aria-hidden="true"
                  />
                  {position.monthLabel}
                </span>
                <span className="flex items-center gap-2">
                  <select
                    value={month ?? position.monthStart}
                    onChange={(e) => setMonth(e.target.value)}
                    aria-label="VAT month"
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid="select-vat-month"
                  >
                    {position.months.map((m) => (
                      <option key={m} value={m}>
                        {vatMonthLabel(m)}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      window.location.assign(
                        vatCsvHref(clientPartyId, position.monthStart),
                      )
                    }
                    data-testid="button-vat-csv"
                  >
                    <Download className="w-4 h-4 mr-1" aria-hidden="true" /> CSV
                  </Button>
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {vatDeadline && (
                <p
                  className="flex flex-wrap items-center gap-2"
                  data-testid="text-vat-due"
                >
                  <span className={severityBadgeClasses(vatDeadline.severity)}>
                    Next return due {formatLagosDate(vatDeadline.dueDate)}
                  </span>
                  <Link
                    href="/calendar"
                    className="text-primary text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                  >
                    View calendar
                  </Link>
                </p>
              )}
              {position.outputInvoiceCount === 0 && position.billCount === 0 ? (
                <p
                  className="text-sm text-muted-foreground text-center py-4"
                  data-testid="text-vat-empty"
                >
                  No issued documents or supplier bills in {position.monthLabel}{" "}
                  yet — nothing to compute.
                </p>
              ) : (
                <>
                  <div className="divide-y text-sm">
                    {vatRows(position).map((row) => (
                      <div
                        key={row.key}
                        className={`flex items-baseline justify-between gap-4 py-2 ${
                          row.sub ? "pl-4 text-xs text-muted-foreground" : ""
                        } ${row.strong ? "font-semibold" : ""}`}
                      >
                        <span>{row.label}</span>
                        <span
                          className="tabular-nums text-right"
                          data-testid={row.testId}
                        >
                          {row.value}
                        </span>
                      </div>
                    ))}
                  </div>
                  {comparison && (
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="text-vat-compare"
                    >
                      {comparison}
                    </p>
                  )}
                </>
              )}
              {fxLine && (
                <p
                  className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                  data-testid="text-vat-fx-excluded"
                >
                  {fxLine}
                </p>
              )}
              <p
                className="text-xs text-muted-foreground"
                data-testid="text-vat-note"
              >
                {position.note}
              </p>
            </CardContent>
          </Card>
        )}
      </RequireClientScope>
    </div>
  );
}
