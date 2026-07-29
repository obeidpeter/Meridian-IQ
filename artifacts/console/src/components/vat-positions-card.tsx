import { useState } from "react";
import {
  useGetFirmVatPositions,
  getGetFirmVatPositionsQueryKey,
} from "@workspace/api-client-react";
import type { FirmVatPositionRow } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNaira } from "@/lib/format";

// VAT position across the firm's book (contract 0.45.0): per-client output
// VAT vs input VAT for a Lagos month, with the verified-input posture — the
// firm-side mirror of each client's own VAT position page, computed by the
// same server core so the two can never disagree. Render-on-success like the
// VAT pack beside it: a 403 for roles without the portfolio capability (or a
// 404 from an older server build) simply hides the card.

// "2026-06-01" -> "June 2026" for the month picker.
const POSITION_MONTHS = [
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

export function vatPositionsMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${POSITION_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/**
 * Table order: largest net liability first — the clients whose filing needs
 * the most attention lead — with a stable name tiebreak. Non-mutating.
 */
export function sortVatPositionRows(
  rows: readonly FirmVatPositionRow[],
): FirmVatPositionRow[] {
  return [...rows].sort((a, b) => {
    const diff = Number(b.netVat) - Number(a.netVat);
    if (diff !== 0) return diff;
    return a.clientName.localeCompare(b.clientName);
  });
}

export function VatPositionsCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data, isSuccess } = useGetFirmVatPositions(params, {
    query: { queryKey: getGetFirmVatPositionsQueryKey(params), retry: false },
  });
  if (!isSuccess || !data) return null;
  const rows = sortVatPositionRows(data.rows);
  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-vat-positions"
    >
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>VAT positions — {data.monthLabel}</span>
          <Select value={data.monthStart} onValueChange={(m) => setMonth(m)}>
            <SelectTrigger
              className="h-8 w-44 text-xs"
              aria-label="VAT positions month"
              data-testid="select-vat-positions-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data.months.map((m) => (
                <SelectItem key={m} value={m}>
                  {vatPositionsMonthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-vat-positions-empty"
          >
            No VAT activity across the book in {data.monthLabel}.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="table-vat-positions">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium text-right">
                    Output VAT
                  </th>
                  <th className="py-2 pr-3 font-medium text-right">
                    Input VAT
                  </th>
                  <th className="py-2 pr-3 font-medium text-right">
                    Verified input
                  </th>
                  <th className="py-2 pr-3 font-medium text-right">Net</th>
                  <th className="py-2 font-medium text-right">Defensible</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr
                    key={r.clientPartyId}
                    data-testid={`row-vat-position-${r.clientPartyId}`}
                  >
                    <td className="py-2 pr-3 max-w-[16rem] truncate">
                      {r.clientName}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.outputVat)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.inputVat)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.inputVatVerified)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums font-medium">
                      {formatNaira(r.netVat)}
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {formatNaira(r.defensibleNetVat)}
                    </td>
                  </tr>
                ))}
                <tr
                  className="font-semibold"
                  data-testid="text-vat-positions-totals"
                >
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(data.totals.outputVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(data.totals.inputVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(data.totals.inputVatVerified)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(data.totals.netVat)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatNaira(data.totals.defensibleNetVat)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{data.note}</p>
      </CardContent>
    </Card>
  );
}
