import {
  useRef,
  useState,
  type Dispatch,
  type FormEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  createInvoiceRoomPaymentLink,
  getPublicInvoiceRoom,
  reportInvoiceRoomPayment,
} from "@workspace/api-client-react";
import type {
  InvoiceRoomDetail,
  InvoiceRoomPaymentRequest,
} from "@workspace/api-client-react";
import {
  Banknote,
  Check,
  CheckCircle2,
  ExternalLink,
  Landmark,
  Loader2,
  ReceiptText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  actionKey,
  errorMessage,
  formatAmount,
  formatDate,
  formatDateTime,
  localDateTimeValue,
  type RoomAction,
} from "./helpers";

// The "I have already paid" report. Every field edit clears the report's
// idempotency key (the ref is the panel's own) so a resubmission after an edit
// is a new attempt.
function PaymentReportForm({
  reference,
  setReference,
  paidAt,
  setPaidAt,
  note,
  setNote,
  reportKey,
  pending,
  onSubmit,
}: {
  reference: string;
  setReference: Dispatch<SetStateAction<string>>;
  paidAt: string;
  setPaidAt: Dispatch<SetStateAction<string>>;
  note: string;
  setNote: Dispatch<SetStateAction<string>>;
  reportKey: RefObject<string | null>;
  pending: RoomAction | null;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form
      onSubmit={onSubmit}
      className="mt-5 space-y-4 border-t border-slate-200 pt-5"
    >
      <p className="text-sm leading-6 text-slate-600">
        Add your transfer reference so the supplier can match it to this
        invoice. This records your report, not confirmation that the supplier
        received the money.
      </p>
      <div>
        <Label htmlFor="payment-reference" className="font-bold text-slate-800">
          Transfer reference
        </Label>
        <Input
          id="payment-reference"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
            reportKey.current = null;
          }}
          required
          maxLength={200}
          autoComplete="off"
          className="mt-2 h-11 border-slate-300 bg-white"
        />
      </div>
      <div>
        <Label htmlFor="payment-date" className="font-bold text-slate-800">
          Payment date and time
        </Label>
        <Input
          id="payment-date"
          type="datetime-local"
          value={paidAt}
          max={localDateTimeValue(new Date(Date.now() + 5 * 60_000))}
          onChange={(event) => {
            setPaidAt(event.target.value);
            reportKey.current = null;
          }}
          required
          className="mt-2 h-11 border-slate-300 bg-white"
        />
      </div>
      <div>
        <Label htmlFor="payment-note" className="font-bold text-slate-800">
          Note (optional)
        </Label>
        <textarea
          id="payment-note"
          value={note}
          onChange={(event) => {
            setNote(event.target.value);
            reportKey.current = null;
          }}
          maxLength={2000}
          rows={2}
          className="mt-2 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
        />
      </div>
      <Button
        type="submit"
        disabled={pending !== null || !reference.trim() || !paidAt}
        className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
      >
        {pending === "report-payment" ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <Check aria-hidden="true" />
        )}{" "}
        Save payment report
      </Button>
    </form>
  );
}

export function PaymentPanel({
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
  const [showReport, setShowReport] = useState(false);
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(() => localDateTimeValue());
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reportKey = useRef<string | null>(null);
  const linkKey = useRef<string | null>(null);
  const activeCheckout = detail.payment.requests.find(
    (request) => request.status === "pending" && request.checkoutUrl,
  );

  const createLink = async () => {
    setError(null);
    setPending("payment-link");
    linkKey.current ??= actionKey();
    try {
      const request: InvoiceRoomPaymentRequest =
        await createInvoiceRoomPaymentLink({ idempotencyKey: linkKey.current });
      linkKey.current = null;
      if (request.checkoutUrl) window.location.assign(request.checkoutUrl);
      else onChange(await getPublicInvoiceRoom());
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const report = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending("report-payment");
    reportKey.current ??= actionKey();
    try {
      const result = await reportInvoiceRoomPayment({
        idempotencyKey: reportKey.current,
        paidAt: new Date(paidAt).toISOString(),
        reference: reference.trim(),
        note: note.trim() || null,
      });
      reportKey.current = null;
      onChange(result);
      setShowReport(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="border border-slate-200 bg-white p-5"
      aria-labelledby="payment-heading"
    >
      <div className="flex items-center gap-3">
        <span
          className={`grid size-10 place-items-center rounded-md ${detail.payment.settled ? "bg-emerald-100 text-emerald-800" : "bg-blue-50 text-blue-800"}`}
        >
          {detail.payment.settled ? (
            <CheckCircle2 className="size-5" aria-hidden="true" />
          ) : (
            <Banknote className="size-5" aria-hidden="true" />
          )}
        </span>
        <div>
          <h2 id="payment-heading" className="font-extrabold">
            {detail.payment.settled ? "Payment recorded" : "Payment"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {detail.payment.settled
              ? `Payment evidence recorded ${detail.payment.latestEvidenceAt ? formatDateTime(detail.payment.latestEvidenceAt) : ""}`
              : `${formatAmount(detail.invoice.grandTotal, detail.invoice.currency)} due ${formatDate(detail.invoice.dueDate)}`}
          </p>
        </div>
      </div>

      {!detail.payment.settled && detail.payment.instructions && (
        <dl className="mt-5 divide-y divide-slate-200 border-y border-slate-200 text-sm">
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-slate-500">Payment service</dt>
            <dd className="text-right font-bold">
              {detail.payment.instructions.label ??
                detail.payment.instructions.provider}
            </dd>
          </div>
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-slate-500">Account reference</dt>
            <dd className="break-all text-right font-mono font-bold">
              {detail.payment.instructions.accountReference}
            </dd>
          </div>
        </dl>
      )}

      {!detail.payment.settled && (
        <div className="mt-5 flex flex-wrap gap-2">
          {activeCheckout?.checkoutUrl ? (
            <Button
              asChild
              className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
            >
              <a href={activeCheckout.checkoutUrl}>
                <ExternalLink aria-hidden="true" /> Continue to payment
              </a>
            </Button>
          ) : detail.permissions.canCreatePaymentLink ? (
            <Button
              type="button"
              onClick={() => void createLink()}
              disabled={pending !== null}
              className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
            >
              {pending === "payment-link" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Landmark aria-hidden="true" />
              )}{" "}
              Open payment link
            </Button>
          ) : null}
          {detail.permissions.canReportPayment && (
            <Button
              type="button"
              variant="outline"
              className="min-h-11"
              onClick={() => setShowReport((value) => !value)}
              disabled={pending !== null}
            >
              <ReceiptText aria-hidden="true" /> I have already paid
            </Button>
          )}
        </div>
      )}

      {showReport && !detail.payment.settled && (
        <PaymentReportForm
          reference={reference}
          setReference={setReference}
          paidAt={paidAt}
          setPaidAt={setPaidAt}
          note={note}
          setNote={setNote}
          reportKey={reportKey}
          pending={pending}
          onSubmit={report}
        />
      )}
      {error && (
        <p
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          {error}
        </p>
      )}
    </section>
  );
}
