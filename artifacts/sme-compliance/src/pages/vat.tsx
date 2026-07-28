import { useState } from "react";
import {
  useGetMe,
  useGetVatPosition,
  getGetVatPositionQueryKey,
  getExportVatPositionCsvUrl,
} from "@workspace/api-client-react";
import type {
  GetVatPositionParams,
  VatPosition as VatPositionPayload,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { SkeletonList } from "@/components/skeleton-list";
import { usePageTitle } from "@/hooks/use-page-title";
import { Download, Percent } from "lucide-react";
import { formatNaira } from "@/lib/format";

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
      label: "Net VAT position",
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
  const params: GetVatPositionParams = month
    ? { clientPartyId, month }
    : { clientPartyId };

  const {
    data: position,
    isLoading,
    isError,
    refetch,
  } = useGetVatPosition(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetVatPositionQueryKey(params),
    },
  });

  const fxLine = position ? fxExcludedLine(position.excludedForFx) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="VAT position"
        description="Output VAT from your issued documents against input VAT from your supplier bills — one month at a time."
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
                  <Percent className="w-4 h-4 text-primary" aria-hidden="true" />
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
              {position.outputInvoiceCount === 0 && position.billCount === 0 ? (
                <p
                  className="text-sm text-muted-foreground text-center py-4"
                  data-testid="text-vat-empty"
                >
                  No issued documents or supplier bills in {position.monthLabel}{" "}
                  yet — nothing to compute.
                </p>
              ) : (
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
