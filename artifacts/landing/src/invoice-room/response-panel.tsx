import { useRef, useState } from "react";
import { respondInvoiceRoom } from "@workspace/api-client-react";
import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { Check, CheckCircle2, FileCheck2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  actionKey,
  errorMessage,
  formatDateTime,
  RESPONSE_LABEL,
  type ResponseState,
  type RoomAction,
} from "./helpers";

export function ResponsePanel({
  detail,
  pending,
  setPending,
  onChange,
}: {
  detail: InvoiceRoomDetail;
  pending: RoomAction | null;
  setPending: (action: RoomAction | null) => void;
  onChange: (detail: InvoiceRoomDetail) => void;
}) {
  const [choice, setChoice] = useState<ResponseState | null>(null);
  const [note, setNote] = useState("");
  const [noSetOff, setNoSetOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const noteRequired = choice === "queried" || choice === "rejected";

  const submit = async () => {
    if (!choice || (noteRequired && !note.trim())) return;
    setError(null);
    setPending("respond");
    key.current ??= actionKey();
    try {
      const result = await respondInvoiceRoom({
        idempotencyKey: key.current,
        state: choice,
        note: note.trim() || null,
        noSetOff: choice === "confirmed" ? noSetOff : false,
      });
      key.current = null;
      onChange(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  if (!detail.permissions.canRespond) {
    if (!detail.confirmation) return null;
    return (
      <section
        className="border border-slate-200 bg-white p-5"
        aria-labelledby="response-heading"
      >
        <div className="flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-md bg-slate-100 text-slate-700">
            <CheckCircle2 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h2 id="response-heading" className="font-extrabold">
              Your invoice response
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {RESPONSE_LABEL[detail.confirmation.state]}
            </p>
          </div>
        </div>
        {detail.confirmation.note && (
          <p className="mt-4 border-l-2 border-slate-300 pl-3 text-sm leading-6 text-slate-700">
            {detail.confirmation.note}
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500">
          Recorded {formatDateTime(detail.confirmation.createdAt)}
        </p>
      </section>
    );
  }

  return (
    <section
      className="border border-slate-200 bg-white p-5"
      aria-labelledby="response-heading"
    >
      <div className="flex items-center gap-3">
        <span className="grid size-10 place-items-center rounded-md bg-lime-100 text-teal-900">
          <FileCheck2 className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="response-heading" className="font-extrabold">
            Respond to this invoice
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Your response and its date and time are saved in the invoice
            history. Confirming an invoice does not confirm payment.
          </p>
        </div>
      </div>
      <fieldset className="mt-5">
        <legend className="sr-only">Choose an invoice response</legend>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          {(["confirmed", "queried", "rejected"] as const).map((state) => (
            <button
              key={state}
              type="button"
              onClick={() => {
                setChoice(state);
                key.current = null;
                setError(null);
              }}
              aria-pressed={choice === state}
              className={`min-h-11 rounded-md border px-3 py-2 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700 ${choice === state ? (state === "rejected" ? "border-red-600 bg-red-50 text-red-800" : state === "queried" ? "border-amber-600 bg-amber-50 text-amber-900" : "border-teal-700 bg-teal-50 text-teal-900") : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}
            >
              {state === "confirmed"
                ? "Confirm"
                : state === "queried"
                  ? "Question"
                  : "Reject"}
            </button>
          ))}
        </div>
      </fieldset>
      {choice && (
        <div className="mt-4 space-y-4">
          <div>
            <Label
              htmlFor="invoice-response-note"
              className="font-bold text-slate-800"
            >
              {noteRequired ? "Reason" : "Note (optional)"}
            </Label>
            <textarea
              id="invoice-response-note"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                key.current = null;
              }}
              required={noteRequired}
              maxLength={2000}
              rows={3}
              className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
              placeholder={
                noteRequired
                  ? "Tell the supplier what needs checking or correcting"
                  : "Add a purchase order reference or delivery note details"
              }
            />
          </div>
          {choice === "confirmed" && (
            <label className="flex cursor-pointer items-start gap-3 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={noSetOff}
                onChange={(event) => {
                  setNoSetOff(event.target.checked);
                  key.current = null;
                }}
                className="mt-1 size-4 accent-teal-700"
              />
              <span>
                <span className="font-bold text-slate-900">
                  No set-off is currently expected.
                </span>
                <br />
                The full amount shown remains payable, subject to the agreed
                payment terms.
              </span>
            </label>
          )}
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={pending !== null || (noteRequired && !note.trim())}
            className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
          >
            {pending === "respond" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <Check aria-hidden="true" />
            )}
            Record{" "}
            {choice === "confirmed"
              ? "confirmation"
              : choice === "queried"
                ? "question"
                : "rejection"}
          </Button>
        </div>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
