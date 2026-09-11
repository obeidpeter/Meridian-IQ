import type { BuyerInvoice } from "@workspace/api-client-react";
import {
  getListBuyerInvoicesQueryKey,
  getGetBuyerInvoiceQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Spinner } from "@/components/ui/spinner";
import { CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import {
  RESPONSE_DESCRIPTIONS,
  SUBMIT_LABELS,
  errorDescription,
  noteRequiredFor,
  noteValidationError,
  type ResponseState,
  RESPONSE_FINALITY,
  responseRecordedCopy,
} from "@/lib/respond";
import type { InvoiceRespondState } from "./use-invoice-respond";

const RESPONSE_OPTIONS: Array<{
  state: ResponseState;
  label: string;
  icon: typeof CheckCircle2;
  activeClasses: string;
}> = [
  {
    state: "confirmed",
    label: "Confirm",
    icon: CheckCircle2,
    activeClasses:
      "data-[state=on]:border-emerald-500 data-[state=on]:bg-emerald-50 data-[state=on]:text-emerald-800 dark:data-[state=on]:bg-emerald-950/40 dark:data-[state=on]:text-emerald-300",
  },
  {
    state: "queried",
    label: "Ask a question",
    icon: HelpCircle,
    activeClasses:
      "data-[state=on]:border-blue-500 data-[state=on]:bg-blue-50 data-[state=on]:text-blue-800 dark:data-[state=on]:bg-blue-950/40 dark:data-[state=on]:text-blue-300",
  },
  {
    state: "rejected",
    label: "Reject",
    icon: XCircle,
    activeClasses:
      "data-[state=on]:border-red-500 data-[state=on]:bg-red-50 data-[state=on]:text-red-800 dark:data-[state=on]:bg-red-950/40 dark:data-[state=on]:text-red-300",
  },
];

// The response form for an invoice awaiting the buyer's answer. Takes the
// narrowed invoice (the shell renders it only after the not-found guard)
// plus the page bag.
export function ResponseForm({
  invoice,
  state,
}: {
  invoice: BuyerInvoice;
  state: InvoiceRespondState;
}) {
  const {
    me,
    queryClient,
    toast,
    response,
    setResponse,
    method,
    setMethod,
    note,
    setNoteError,
    noSetOff,
    setNoSetOff,
    setSubmitted,
    noteRef,
    confirm,
  } = state;
  const noteRequired = noteRequiredFor(response);

  const handleSubmit = () => {
    if (!response) return;
    if (!me?.buyerPartyId) {
      toast({
        title: "Your buyer details are not ready",
        description: "Wait a moment, then try again.",
        variant: "destructive",
      });
      return;
    }
    const validation = noteValidationError(response, note);
    if (validation !== null) {
      setNoteError(validation);
      noteRef.current?.focus();
      return;
    }
    confirm.mutate(
      {
        id: invoice.id,
        data: {
          buyerPartyId: me.buyerPartyId,
          state: response,
          method,
          ...(response === "confirmed" ? { noSetOff } : {}),
          ...(note.trim() !== "" ? { note: note.trim() } : {}),
        },
      },
      {
        onSuccess: () => {
          setSubmitted(response);
          toast({
            title: responseRecordedCopy(response).title,
            description: "The supplier can view your recorded response.",
          });
          queryClient.invalidateQueries({
            queryKey: getListBuyerInvoicesQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getGetBuyerInvoiceQueryKey(invoice.id),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not record your response",
            description: errorDescription(err),
            variant: "destructive",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-respond">
      <CardHeader>
        <CardTitle>Respond to confirmation request</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ToggleGroup
          type="single"
          value={response ?? ""}
          onValueChange={(v) => {
            setResponse(v === "" ? null : (v as ResponseState));
            setNoteError(null);
          }}
          aria-label="Your response"
          className="grid grid-cols-3 items-stretch gap-2 w-full"
        >
          {RESPONSE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            return (
              <ToggleGroupItem
                key={opt.state}
                value={opt.state}
                data-testid={`button-response-${opt.state}`}
                className={`flex h-auto flex-col items-center gap-1.5 border rounded-md py-3 px-2 text-sm font-medium transition-colors hover:bg-muted ${opt.activeClasses}`}
              >
                <Icon className="w-5 h-5" aria-hidden="true" />
                {opt.label}
              </ToggleGroupItem>
            );
          })}
        </ToggleGroup>

        {/* What the picked action DOES, before it is submitted — the
            one-word toggle labels alone leave the outcome to guesswork. */}
        {response !== null && (
          <p
            className="text-sm text-muted-foreground border rounded-md p-3 bg-muted/40"
            data-testid="text-response-description"
          >
            {RESPONSE_DESCRIPTIONS[response]}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="method">Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger id="method" data-testid="select-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="portal">Portal</SelectItem>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="phone">Phone</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <NoteField state={state} noteRequired={noteRequired} />

        {response === "confirmed" && (
          <div className="border rounded-md p-3 space-y-1.5">
            <div className="flex items-start gap-2">
              <Checkbox
                id="no-set-off"
                checked={noSetOff}
                onCheckedChange={(v) => setNoSetOff(v === true)}
                data-testid="checkbox-no-set-off"
              />
              <Label
                htmlFor="no-set-off"
                className="text-sm font-normal leading-snug"
              >
                We acknowledge no set-off will be applied against this invoice
              </Label>
            </div>
            <p className="text-xs text-muted-foreground pl-6">
              This records that you will not reduce this payment to offset a
              separate amount the supplier owes you. It can support a financing
              assessment but does not guarantee financing.
            </p>
          </div>
        )}

        {response !== null && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="text-response-finality"
          >
            {RESPONSE_FINALITY}
          </p>
        )}

        <Button
          onClick={handleSubmit}
          disabled={!response || confirm.isPending}
          variant={response === "rejected" ? "destructive" : "default"}
          data-testid="button-submit-response"
        >
          {confirm.isPending ? (
            <>
              <Spinner className="mr-2 size-4" /> Submitting…
            </>
          ) : response ? (
            SUBMIT_LABELS[response]
          ) : (
            "Choose a response"
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// Module-scoped (never nested in ResponseForm) so the textarea keeps its
// identity — and focus — across keystrokes.
function NoteField({
  state,
  noteRequired,
}: {
  state: InvoiceRespondState;
  noteRequired: boolean;
}) {
  const { note, setNote, noteError, setNoteError, noteRef } = state;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="note">
        Note{noteRequired ? " (required)" : " (optional)"}
      </Label>
      <Textarea
        id="note"
        ref={noteRef}
        value={note}
        onChange={(e) => {
          setNote(e.target.value);
          if (e.target.value.trim() !== "") setNoteError(null);
        }}
        aria-invalid={noteError !== null}
        aria-describedby={noteError !== null ? "note-error" : undefined}
        className={
          noteError !== null
            ? "border-destructive focus-visible:ring-destructive"
            : undefined
        }
        placeholder={
          noteRequired
            ? "Explain what needs correcting on this invoice…"
            : "Anything the supplier should know…"
        }
        data-testid="input-note"
      />
      {noteRequired && noteError === null && (
        <p className="text-xs text-muted-foreground">
          Required — your note is what the supplier sees.
        </p>
      )}
      {noteError !== null && (
        <p
          id="note-error"
          role="alert"
          className="text-sm text-destructive"
          data-testid="text-note-error"
        >
          {noteError}
        </p>
      )}
    </div>
  );
}
