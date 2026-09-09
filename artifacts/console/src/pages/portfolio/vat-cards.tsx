import { useState } from "react";
import {
  getGetVatPackQueryKey,
  useGetVatPack,
  useDraftVatPackCoverNote,
  type VatPackCoverNote,
  useGetVatSettlementCheck,
  useGetVatPosition,
  getGetVatPositionQueryKey,
  getGetVatSettlementCheckQueryKey,
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
import { StatTile } from "@/components/stat-tile";
import { ScrollRegion } from "@/components/scroll-region";
import { Download, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatNaira, formatDate, formatPct } from "@/lib/format";
import { formatMoney } from "./format";
import {
  CoverNotePanel,
  coverNoteHandlers,
  packMonthLabel,
} from "./cover-note";

// Monthly VAT filing pack (exhaust idea #2): per-client output VAT for a
// closed Lagos month, deterministic end to end — the numbers mirror the
// per-client statements. Renders only on success (a 403 for roles without
// the portfolio capability simply hides the card).
export function VatPackCard() {
  const { toast } = useToast();
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: pack, isSuccess } = useGetVatPack(params, {
    query: { queryKey: getGetVatPackQueryKey(params), retry: false },
  });

  // Cover note (round-4 idea #6): phrases the pack's own numbers; the
  // partner edits and owns the text — nothing is stored server-side.
  const coverNote = useDraftVatPackCoverNote();
  const [note, setNote] = useState<VatPackCoverNote | null>(null);
  const [noteText, setNoteText] = useState("");
  const draftNote = (monthStart: string) => {
    coverNote.mutate(
      { data: { month: monthStart } },
      coverNoteHandlers<VatPackCoverNote>(setNote, setNoteText, toast),
    );
  };

  if (!isSuccess || !pack) return null;
  const exportHref = `/api/vat-pack/export?month=${encodeURIComponent(pack.monthStart)}`;
  return (
    <Card className="shadow-sm" data-testid="card-vat-pack">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>VAT filing pack</span>
          <span className="flex items-center gap-2">
            <Select
              value={pack.monthStart}
              onValueChange={(m) => {
                setMonth(m);
                setNote(null);
              }}
            >
              <SelectTrigger
                className="h-8 w-44 text-xs"
                data-testid="select-vat-pack-month"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pack.months.map((m) => (
                  <SelectItem key={m} value={m}>
                    {packMonthLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.location.assign(exportHref)}
              data-testid="button-vat-pack-csv"
            >
              <Download className="w-4 h-4 mr-1" aria-hidden="true" /> CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={coverNote.isPending}
              onClick={() => draftNote(pack.monthStart)}
              data-testid="button-vat-cover-note"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {coverNote.isPending ? "Drafting…" : "Cover note"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pack.rows.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-vat-pack-empty"
          >
            No invoices were accepted by the rails in {pack.monthLabel}.
          </p>
        ) : (
          <ScrollRegion label="VAT filing pack table">
            <table className="w-full text-sm" data-testid="table-vat-pack">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium text-right">Accepted</th>
                  <th className="py-2 pr-3 font-medium text-right">Total</th>
                  <th className="py-2 pr-3 font-medium text-right">
                    Output VAT
                  </th>
                  <th className="py-2 pr-3 font-medium text-right">Credits</th>
                  <th className="py-2 font-medium text-right">Net VAT</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pack.rows.map((r) => (
                  <tr
                    key={r.clientPartyId}
                    data-testid={`row-vat-${r.clientPartyId}`}
                  >
                    <td className="py-2 pr-3">{r.clientName}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.acceptedCount}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.acceptedTotal)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatNaira(r.acceptedVat)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {r.creditCount > 0 ? `−${formatNaira(r.creditVat)}` : "—"}
                    </td>
                    <td className="py-2 text-right tabular-nums font-medium">
                      {formatNaira(r.netVat)}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className="py-2 pr-3">Total</td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pack.totals.acceptedCount}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(pack.totals.acceptedTotal)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {formatNaira(pack.totals.acceptedVat)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {pack.totals.creditCount > 0
                      ? `−${formatNaira(pack.totals.creditVat)}`
                      : "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatNaira(pack.totals.netVat)}
                  </td>
                </tr>
              </tbody>
            </table>
          </ScrollRegion>
        )}
        <p className="text-xs text-muted-foreground">{pack.note}</p>
        {note && (
          <CoverNotePanel
            periodLabel={note.monthLabel}
            source={note.source}
            destinationWord="email"
            text={noteText}
            onChange={setNoteText}
            onDiscard={() => setNote(null)}
            testIds={{
              panel: "vat-cover-note",
              input: "input-vat-cover-note",
              copy: "button-copy-cover-note",
              discard: "button-discard-cover-note",
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

// VAT settlement cross-check (round-13 idea #6): how much of the pack
// month's accepted value the platform has OBSERVED settling. Deliberately an
// assurance view — the server's note says "unobserved, not unpaid" and it
// renders with every state.
// Net VAT position (round-15 idea #1): output VAT from the pack minus
// VERIFIED input VAT on the month's supplier bills — the filing number,
// with the unverified list as the recovery CTA.
export function VatPositionCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: position, isSuccess } = useGetVatPosition(params, {
    query: { queryKey: getGetVatPositionQueryKey(params), retry: false },
  });
  if (!isSuccess || !position) return null;
  return (
    <Card className="shadow-sm" data-testid="card-vat-position">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Net VAT position — {position.monthLabel}</span>
          <Select
            value={position.monthStart}
            onValueChange={(m) => setMonth(m)}
          >
            <SelectTrigger
              className="h-8 w-44 text-xs"
              data-testid="select-vat-position-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {position.months.map((m) => (
                <SelectItem key={m} value={m}>
                  {packMonthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Output VAT (net)"
            value={formatNaira(position.outputNetVat)}
            testId="tile-vat-output"
          />
          <StatTile
            label="Verified input VAT"
            value={formatNaira(position.verifiedVat)}
            detail={`${position.verifiedCount} of ${position.billCount} bills`}
            testId="tile-vat-input"
          />
          <StatTile
            label="Net position"
            value={formatNaira(position.netPosition)}
            testId="tile-vat-net"
          />
          <StatTile
            label="Unverified input VAT"
            value={formatNaira(position.unverifiedVat)}
            detail={`${position.unverifiedCount} bill(s) to verify`}
            tone={position.unverifiedCount > 0 ? "warning" : undefined}
            testId="tile-vat-unverified"
          />
        </div>
        {position.unverified.length > 0 && (
          <ScrollRegion label="Unverified input-VAT bills table">
            <table
              className="w-full text-sm"
              data-testid="table-vat-unverified-bills"
            >
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Bill</th>
                  <th className="py-2 pr-3 font-medium">Client</th>
                  <th className="py-2 pr-3 font-medium">Supplier</th>
                  <th className="py-2 font-medium text-right">Input VAT</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {position.unverified.map((r) => (
                  <tr key={r.invoiceId}>
                    <td className="py-2 pr-3">{r.invoiceNumber}</td>
                    <td className="py-2 pr-3">{r.clientName}</td>
                    <td className="py-2 pr-3">{r.supplierName}</td>
                    <td className="py-2 text-right tabular-nums">
                      {formatMoney(r.vatTotal, r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {position.unverifiedTruncated && (
              <p className="pt-1 text-xs text-muted-foreground">
                Showing the largest {position.unverified.length} — more exist.
              </p>
            )}
          </ScrollRegion>
        )}
        <p className="text-xs text-muted-foreground">{position.note}</p>
      </CardContent>
    </Card>
  );
}

export function VatSettlementCard() {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const params = month ? { month } : undefined;
  const { data: check, isSuccess } = useGetVatSettlementCheck(params, {
    query: { queryKey: getGetVatSettlementCheckQueryKey(params), retry: false },
  });
  if (!isSuccess || !check) return null;
  return (
    <Card className="shadow-sm" data-testid="card-vat-settlement">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Settlement cross-check — {check.monthLabel}</span>
          <Select value={check.monthStart} onValueChange={(m) => setMonth(m)}>
            <SelectTrigger
              className="h-8 w-44 text-xs"
              data-testid="select-vat-settlement-month"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {check.months.map((m) => (
                <SelectItem key={m} value={m}>
                  {packMonthLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {check.acceptedCount === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-vat-settlement-empty"
          >
            No invoices were accepted by the rails in {check.monthLabel}.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTile
                label="Accepted"
                value={`${check.acceptedCount}`}
                detail={formatNaira(check.acceptedTotal)}
                testId="tile-settlement-accepted"
              />
              <StatTile
                label="Settlement observed"
                value={
                  check.settledShare != null
                    ? formatPct(check.settledShare)
                    : "—"
                }
                detail={`${check.settledCount} · ${formatNaira(check.settledTotal)}`}
                testId="tile-settlement-observed"
              />
              <StatTile
                label="Not yet observed"
                value={`${check.outstandingCount}`}
                detail={formatNaira(check.outstandingTotal)}
                testId="tile-settlement-outstanding"
              />
              <StatTile
                label="Since credited"
                value={`${check.creditedCount}`}
                detail={formatNaira(check.creditedTotal)}
                testId="tile-settlement-credited"
              />
            </div>
            {check.unsettled.length > 0 && (
              <ScrollRegion label="Unsettled invoices table">
                <table
                  className="w-full text-sm"
                  data-testid="table-vat-unsettled"
                >
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Invoice</th>
                      <th className="py-2 pr-3 font-medium">Client</th>
                      <th className="py-2 pr-3 font-medium">Buyer</th>
                      <th className="py-2 pr-3 font-medium">Due</th>
                      <th className="py-2 font-medium text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {check.unsettled.map((r) => (
                      <tr
                        key={r.invoiceId}
                        data-testid={`row-unsettled-${r.invoiceId}`}
                      >
                        <td className="py-2 pr-3">{r.invoiceNumber}</td>
                        <td className="py-2 pr-3">{r.clientName}</td>
                        <td className="py-2 pr-3">{r.buyerName}</td>
                        <td className="py-2 pr-3">{formatDate(r.dueDate)}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatMoney(r.grandTotal, r.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {check.unsettledTruncated && (
                  <p className="pt-1 text-xs text-muted-foreground">
                    Showing the largest {check.unsettled.length} — more exist.
                  </p>
                )}
              </ScrollRegion>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">{check.note}</p>
      </CardContent>
    </Card>
  );
}
