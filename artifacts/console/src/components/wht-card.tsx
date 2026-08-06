import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useListWhtCredits,
  useMarkWhtNoteReceived,
  useGetWhtRemittance,
  getListWhtCreditsQueryKey,
  getGetWhtRemittanceQueryKey,
} from "@workspace/api-client-react";
import type { WhtCredit } from "@workspace/api-client-react";
import {
  whtCategoryLabel,
  whtCreditStatusLabel,
} from "@workspace/format/wht-copy";
import { localDayIso } from "@workspace/format/notice-copy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { formatDate, formatNaira, pillClasses, type BadgeTone } from "@/lib/format";
import { HandCoins } from "lucide-react";

// WHT Desk for one client: the withholding-credit ledger (deductions a buyer
// took on the client's receivables, each owed a credit note) and the period's
// remittance schedule (WHT-categorised supplier bills the client must remit
// on). "Mark note received" captures the credit note's reference + date as
// evidence — the filings-card filed-evidence posture exactly. The platform
// records the deductions and notes as the firm sees them; it never claims or
// remits anything itself.
//
// Renders nothing until the credits list succeeds, and nothing for an empty
// book (no credits AND no remittance rows) — the matrix-card precedent: an
// empty ledger is not worth a card. Note actions gate on the invoice.write
// capability (the one the server's note route asserts — WHT credits are
// invoice-spine evidence, not filing-register rows), so a read-only viewer
// (auditor) sees the ledger and its pills but no buttons that could only
// ever 403.

// ---- Pure helpers (unit-tested directly) -----------------------------------

/**
 * The status pill's words and tone. The WORDS come from the shared wht-copy
 * vocabulary; the TONES are console-local: amber an awaiting note (chase
 * it), emerald a received one (evidence in hand), slate anything
 * off-catalogue from a newer server.
 */
export function whtCreditPill(
  status: WhtCredit["status"] | string,
): { tone: BadgeTone; label: string } {
  const tone: BadgeTone =
    status === "note_received"
      ? "emerald"
      : status === "awaiting_note"
        ? "amber"
        : "slate";
  return { tone, label: whtCreditStatusLabel(status) };
}

// ---- The card ---------------------------------------------------------------

export function WhtCard({ clientPartyId }: { clientPartyId: string }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const params = { clientPartyId };
  const credits = useListWhtCredits(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getListWhtCreditsQueryKey(params),
      staleTime: 60_000,
      retry: false,
    },
  });
  // The current period's schedule (the server defaults the period); its
  // failure or emptiness only hides the strip, never the ledger.
  const remittance = useGetWhtRemittance(params, {
    query: {
      enabled: !!clientPartyId,
      queryKey: getGetWhtRemittanceQueryKey(params),
      staleTime: 60_000,
      retry: false,
    },
  });

  // getListWhtCreditsQueryKey() prefix-matches every filtered variant of the
  // list (this client's, the SME app's twin), so all go stale together after
  // a write.
  const invalidateCredits = () =>
    queryClient.invalidateQueries({ queryKey: getListWhtCreditsQueryKey() });

  const { data: me } = useGetMe();
  const canWrite = !!me?.capabilities.includes("invoice.write");

  // "Mark note received" panel: which row is expanded (one at a time) and
  // its evidence draft — the note date defaults to today, the reference is
  // the buyer's credit-note number, required by the contract.
  const [notePanelId, setNotePanelId] = useState<string | null>(null);
  const [noteDate, setNoteDate] = useState("");
  const [noteReference, setNoteReference] = useState("");

  const toggleNotePanel = (id: string) => {
    setNotePanelId((cur) => (cur === id ? null : id));
    // Fresh evidence draft either way (BROWSER-local by design — a form
    // default, not a statutory clock).
    setNoteDate(localDayIso(new Date()));
    setNoteReference("");
  };

  const markReceived = useMarkWhtNoteReceived({
    mutation: {
      onSuccess: () => {
        invalidateCredits();
        setNotePanelId(null);
        toast({ title: "Credit note recorded" });
      },
      onError: (e) =>
        serverErrorToast(toast, e, {
          title: "Could not record the credit note",
          fallback: "Try again.",
        }),
    },
  });

  // Render-on-success like the matrix card beside it: a 403/404 (or a still
  // loading list) simply means no card yet.
  if (!credits.isSuccess || !credits.data) return null;
  const rows = credits.data.credits;
  const totals = credits.data.totals;
  const remit = remittance.isSuccess ? remittance.data : undefined;
  const remitRows = remit?.rows ?? [];
  // An empty book — no credits recorded AND nothing on the period's
  // remittance schedule — has no card, not an empty ledger.
  if (rows.length === 0 && remitRows.length === 0) return null;

  return (
    <Card data-testid="card-wht">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HandCoins className="w-5 h-5" aria-hidden="true" /> WHT credits
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length > 0 && (
          <div className="space-y-2">
            {rows.map((c) => {
              const pill = whtCreditPill(c.status);
              return (
                <div
                  key={c.id}
                  className="border rounded-md p-3"
                  data-testid={`row-wht-${c.id}`}
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <p className="font-medium text-sm">
                      {c.invoiceNumber} · {whtCategoryLabel(c.category)}
                    </p>
                    <span
                      className={pillClasses(pill.tone)}
                      data-testid={`pill-wht-${c.id}`}
                    >
                      {pill.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatNaira(c.amount)} withheld ·{" "}
                    {formatDate(c.deductedDate)}
                    {c.noteReference ? ` · Note ${c.noteReference}` : ""}
                    {c.noteDate ? ` · ${formatDate(c.noteDate)}` : ""}
                  </p>
                  {canWrite && c.status === "awaiting_note" && (
                    <div className="mt-2">
                      <Button
                        size="sm"
                        variant={
                          notePanelId === c.id ? "secondary" : "outline"
                        }
                        onClick={() => toggleNotePanel(c.id)}
                        data-testid={`button-wht-note-${c.id}`}
                      >
                        Mark note received
                      </Button>
                    </div>
                  )}
                  {canWrite &&
                    c.status === "awaiting_note" &&
                    notePanelId === c.id && (
                      <div
                        className="mt-2 rounded-md border p-3 space-y-3"
                        data-testid={`panel-wht-note-${c.id}`}
                      >
                        <div className="grid sm:grid-cols-2 gap-3">
                          <div className="space-y-1">
                            <Label htmlFor={`wht-note-reference-${c.id}`}>
                              Credit note reference
                            </Label>
                            <Input
                              id={`wht-note-reference-${c.id}`}
                              value={noteReference}
                              onChange={(e) =>
                                setNoteReference(e.target.value)
                              }
                              data-testid={`input-wht-note-reference-${c.id}`}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label htmlFor={`wht-note-date-${c.id}`}>
                              Note date
                            </Label>
                            <Input
                              id={`wht-note-date-${c.id}`}
                              type="date"
                              value={noteDate}
                              onChange={(e) => setNoteDate(e.target.value)}
                              data-testid={`input-wht-note-date-${c.id}`}
                            />
                          </div>
                        </div>
                        <Button
                          size="sm"
                          onClick={() =>
                            // The contract requires BOTH fields; the
                            // reference is trimmed before it travels.
                            markReceived.mutate({
                              id: c.id,
                              data: {
                                noteReference: noteReference.trim(),
                                noteDate,
                              },
                            })
                          }
                          disabled={
                            !noteReference.trim() ||
                            !noteDate ||
                            markReceived.isPending
                          }
                          data-testid={`button-wht-note-confirm-${c.id}`}
                        >
                          {markReceived.isPending
                            ? "Recording…"
                            : "Confirm received"}
                        </Button>
                      </div>
                    )}
                </div>
              );
            })}
          </div>
        )}
        {rows.length > 0 && (
          <p className="text-sm font-medium" data-testid="text-wht-totals">
            <span
              className={
                totals.awaitingNote > 0
                  ? "text-amber-700 dark:text-amber-400"
                  : ""
              }
            >
              {totals.awaitingNote} awaiting note (
              {formatNaira(totals.awaitingAmount)})
            </span>{" "}
            · {totals.noteReceived} received
          </p>
        )}
        {remit && remitRows.length > 0 && (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-wht-remittance"
          >
            {remit.totals.bills} bill{remit.totals.bills === 1 ? "" : "s"} ·{" "}
            {formatNaira(remit.totals.whtAmount)} to remit for{" "}
            {remit.periodLabel} — due {formatDate(remit.dueDate)}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Evidence only — the ledger records the deductions and credit notes
          as the firm sees them; the platform never claims or remits anything
          itself.
        </p>
      </CardContent>
    </Card>
  );
}
