import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  claimInvoiceRoomAccount,
  createInvoiceRoomPaymentLink,
  exchangeInvoiceRoomToken,
  getPublicInvoiceRoom,
  reportInvoiceRoomPayment,
  requestInvoiceRoomOtp,
  respondInvoiceRoom,
  verifyInvoiceRoomOtp,
} from "@workspace/api-client-react";
import type {
  InvoiceRoomClaimResult,
  InvoiceRoomConfirmationState,
  InvoiceRoomDetail,
  InvoiceRoomPaymentRequest,
} from "@workspace/api-client-react";
import {
  AlertCircle,
  ArrowRight,
  Banknote,
  Check,
  CheckCircle2,
  Clock3,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  Fingerprint,
  Landmark,
  Loader2,
  LockKeyhole,
  Mail,
  MessageCircle,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  UserRoundPlus,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { serverErrorFrom } from "@/lib/errors";

type RoomAction =
  | "exchange"
  | "verify-send"
  | "verify-code"
  | "respond"
  | "report-payment"
  | "payment-link"
  | "claim";

type ResponseState = "confirmed" | "queried" | "rejected";

const RESPONSE_LABEL: Record<InvoiceRoomConfirmationState, string> = {
  requested: "Response requested",
  confirmed: "Confirmed",
  queried: "Query raised",
  rejected: "Rejected",
};

const EVENT_LABEL: Record<string, string> = {
  created: "Secure room created",
  opened: "Invoice opened",
  delivery_sent: "Secure link delivered",
  identity_verified: "Buyer contact verified",
  confirmed: "Invoice confirmed",
  queried: "Query raised",
  rejected: "Invoice rejected",
  payment_reported: "Payment reported",
  payment_link_created: "Secure payment link created",
  payment_confirmed: "Payment confirmed",
  claimed: "Added to Buyer Rails",
  reminder_sent: "Payment reminder sent",
};

function readAndClearRoomToken(): string | null {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;
  const token = new URLSearchParams(hash).get("token")?.trim() ?? null;
  if (hash) {
    window.history.replaceState(
      window.history.state,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  }
  return token;
}

function actionKey(): string {
  return crypto.randomUUID();
}

function localDateTimeValue(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatAmount(value: string, currency: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return `${currency} ${value}`;
  try {
    return new Intl.NumberFormat("en-NG", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(number);
  } catch {
    return `${currency} ${number.toLocaleString("en-NG", { minimumFractionDigits: 2 })}`;
  }
}

function formatDate(value: string | null): string {
  if (!value) return "Not specified";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-NG", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function errorMessage(error: unknown): string {
  return (
    serverErrorFrom(error) ??
    (error instanceof Error ? error.message : null) ??
    "That action could not be completed. Check your connection and try again."
  );
}

function statusTone(detail: InvoiceRoomDetail): {
  label: string;
  className: string;
  Icon: typeof CheckCircle2;
} {
  if (detail.payment.settled) {
    return {
      label: "Payment confirmed",
      className: "border-emerald-300 bg-emerald-50 text-emerald-800",
      Icon: CheckCircle2,
    };
  }
  if (detail.confirmation?.state === "rejected") {
    return {
      label: "Rejected",
      className: "border-red-300 bg-red-50 text-red-800",
      Icon: XCircle,
    };
  }
  if (detail.confirmation?.state === "queried") {
    return {
      label: "Query raised",
      className: "border-amber-300 bg-amber-50 text-amber-900",
      Icon: AlertCircle,
    };
  }
  if (detail.confirmation?.state === "confirmed") {
    return {
      label: "Invoice confirmed",
      className: "border-teal-300 bg-teal-50 text-teal-800",
      Icon: CheckCircle2,
    };
  }
  return {
    label: detail.room.identityVerified
      ? "Awaiting your response"
      : "Verification required",
    className: "border-slate-300 bg-white text-slate-700",
    Icon: detail.room.identityVerified ? Clock3 : LockKeyhole,
  };
}

function InvoiceRoomShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#f4f7f6] text-slate-950">
      <a
        href="#invoice-room-main"
        className="sr-only z-50 rounded-md bg-white px-4 py-2 text-sm font-bold focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to invoice
      </a>
      <header className="border-b border-white/15 bg-[#073f3a] text-white">
        <div className="mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
          <a
            href="/"
            className="flex items-center gap-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lime-300"
          >
            <span className="grid size-9 place-items-center rounded-md bg-lime-300 font-black text-[#073f3a]">
              V
            </span>
            <span>
              <span className="block text-base font-extrabold leading-none">
                Valo
              </span>
              <span className="mt-1 block text-[11px] font-semibold text-teal-100">
                Secure Invoice Room
              </span>
            </span>
          </a>
          <span className="hidden items-center gap-2 text-xs font-semibold text-teal-50 sm:flex">
            <ShieldCheck className="size-4 text-lime-300" aria-hidden="true" />
            Protected document access
          </span>
        </div>
      </header>
      {children}
      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-slate-500 sm:px-8">
          <p>
            Valo · Invoice evidence, confirmation and payment in one secure
            record.
          </p>
          <a
            href="/login"
            className="font-bold text-[#0f5c52] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-700"
          >
            Sign in to Valo
          </a>
        </div>
      </footer>
    </div>
  );
}

function LoadingRoom() {
  return (
    <InvoiceRoomShell>
      <main
        id="invoice-room-main"
        className="mx-auto max-w-7xl px-5 py-16 sm:px-8"
        tabIndex={-1}
      >
        <div className="mx-auto max-w-lg text-center" role="status">
          <span className="mx-auto grid size-12 place-items-center rounded-md bg-teal-100 text-teal-800">
            <Loader2 className="size-6 animate-spin" aria-hidden="true" />
          </span>
          <h1 className="landing-display mt-6 text-3xl font-bold">
            Opening your secure invoice
          </h1>
          <p className="mt-3 text-slate-600">
            Checking the link and preparing the verified document.
          </p>
        </div>
      </main>
    </InvoiceRoomShell>
  );
}

function UnavailableRoom({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const status = (error as { status?: number })?.status;
  const gone = status === 410;
  return (
    <InvoiceRoomShell>
      <main
        id="invoice-room-main"
        className="mx-auto max-w-7xl px-5 py-16 sm:px-8"
        tabIndex={-1}
      >
        <section
          className="mx-auto max-w-xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10"
          aria-labelledby="room-error-title"
        >
          <span className="grid size-12 place-items-center rounded-md bg-amber-100 text-amber-800">
            {gone ? (
              <Clock3 className="size-6" aria-hidden="true" />
            ) : (
              <LockKeyhole className="size-6" aria-hidden="true" />
            )}
          </span>
          <h1
            id="room-error-title"
            className="landing-display mt-6 text-3xl font-bold"
          >
            {gone
              ? "This secure link is no longer active"
              : "We could not open this invoice"}
          </h1>
          <p className="mt-3 leading-7 text-slate-600">{errorMessage(error)}</p>
          <p className="mt-3 text-sm text-slate-500">
            Ask the supplier to send a new Invoice Room link. For your security,
            links can expire or be revoked.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-7"
            onClick={onRetry}
          >
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        </section>
      </main>
    </InvoiceRoomShell>
  );
}

function VerifyPanel({
  detail,
  pending,
  onVerified,
  setPending,
}: {
  detail: InvoiceRoomDetail;
  pending: RoomAction | null;
  onVerified: (detail: InvoiceRoomDetail) => void;
  setPending: (action: RoomAction | null) => void;
}) {
  const firstChannel = detail.room.recipientEmail ? "email" : "whatsapp";
  const [channel, setChannel] = useState<"email" | "whatsapp">(firstChannel);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [debugCode, setDebugCode] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    setError(null);
    setPending("verify-send");
    try {
      const result = await requestInvoiceRoomOtp({ channel });
      setSentTo(result.sentTo);
      setDebugCode(result.debugCode ?? null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending("verify-code");
    try {
      onVerified(await verifyInvoiceRoomOtp({ code: code.trim() }));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="border border-teal-200 bg-teal-50 p-5"
      aria-labelledby="verify-heading"
    >
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-white text-teal-800 shadow-sm">
          <Fingerprint className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="verify-heading" className="text-lg font-extrabold">
            Verify before you respond
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            We will send a one-time code to the contact address chosen by the
            supplier.
          </p>
        </div>
      </div>

      {!sentTo ? (
        <div className="mt-5 space-y-4">
          <fieldset>
            <legend className="text-sm font-bold text-slate-800">
              Send the code by
            </legend>
            <div className="mt-2 grid gap-2">
              {detail.room.recipientEmail && (
                <label
                  className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border bg-white px-3 text-sm font-semibold ${channel === "email" ? "border-teal-700 ring-2 ring-teal-700/15" : "border-slate-300"}`}
                >
                  <input
                    type="radio"
                    name="verification-channel"
                    value="email"
                    checked={channel === "email"}
                    onChange={() => setChannel("email")}
                    className="accent-teal-700"
                  />
                  <Mail className="size-4 text-teal-700" aria-hidden="true" />{" "}
                  <span className="min-w-0 break-all">
                    {detail.room.recipientEmail}
                  </span>
                </label>
              )}
              {detail.room.recipientPhone && (
                <label
                  className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-md border bg-white px-3 text-sm font-semibold ${channel === "whatsapp" ? "border-teal-700 ring-2 ring-teal-700/15" : "border-slate-300"}`}
                >
                  <input
                    type="radio"
                    name="verification-channel"
                    value="whatsapp"
                    checked={channel === "whatsapp"}
                    onChange={() => setChannel("whatsapp")}
                    className="accent-teal-700"
                  />
                  <MessageCircle
                    className="size-4 text-teal-700"
                    aria-hidden="true"
                  />{" "}
                  <span className="min-w-0 break-words">
                    {detail.room.recipientPhone}
                  </span>
                </label>
              )}
            </div>
          </fieldset>
          <Button
            type="button"
            className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
            onClick={() => void requestCode()}
            disabled={pending !== null}
          >
            {pending === "verify-send" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <LockKeyhole aria-hidden="true" />
            )}
            Send verification code
          </Button>
        </div>
      ) : (
        <form onSubmit={verify} className="mt-5 space-y-4">
          <div>
            <Label
              htmlFor="invoice-room-code"
              className="font-bold text-slate-800"
            >
              6-digit code
            </Label>
            <Input
              id="invoice-room-code"
              value={code}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              pattern="[0-9]{6}"
              className="mt-2 h-12 border-slate-300 bg-white font-mono text-lg tracking-[0.2em]"
              aria-describedby="invoice-room-code-help"
            />
            <p
              id="invoice-room-code-help"
              className="mt-2 text-xs text-slate-600"
            >
              Sent to {sentTo}. The code expires in 10 minutes.
              {debugCode ? ` Local test code: ${debugCode}.` : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
              disabled={pending !== null || code.length !== 6}
            >
              {pending === "verify-code" ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck aria-hidden="true" />
              )}
              Verify and continue
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSentTo(null);
                setCode("");
                setError(null);
              }}
              disabled={pending !== null}
            >
              Use another method
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p
          className="mt-4 flex items-start gap-2 rounded-md border border-red-200 bg-white px-3 py-2 text-sm text-red-800"
          role="alert"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{" "}
          {error}
        </p>
      )}
    </section>
  );
}

function ResponsePanel({
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
            Your response is time-stamped in the shared activity record.
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
              {RESPONSE_LABEL[state]}
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
                  ? "Explain what needs attention so the supplier can respond"
                  : "Add a purchase order or receiving note"
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
                ? "query"
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

function PaymentPanel({
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
              ? `Evidence recorded ${detail.payment.latestEvidenceAt ? formatDateTime(detail.payment.latestEvidenceAt) : ""}`
              : `${formatAmount(detail.invoice.grandTotal, detail.invoice.currency)} due ${formatDate(detail.invoice.dueDate)}`}
          </p>
        </div>
      </div>

      {!detail.payment.settled && detail.payment.instructions && (
        <dl className="mt-5 divide-y divide-slate-200 border-y border-slate-200 text-sm">
          <div className="flex justify-between gap-4 py-3">
            <dt className="text-slate-500">Payment route</dt>
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
                <ExternalLink aria-hidden="true" /> Continue secure payment
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
              Pay securely
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
        <form
          onSubmit={report}
          className="mt-5 space-y-4 border-t border-slate-200 pt-5"
        >
          <p className="text-sm leading-6 text-slate-600">
            Report the transfer reference so the supplier can reconcile it
            against this invoice.
          </p>
          <div>
            <Label
              htmlFor="payment-reference"
              className="font-bold text-slate-800"
            >
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
            Record payment report
          </Button>
        </form>
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

function ClaimPanel({
  detail,
  pending,
  setPending,
}: {
  detail: InvoiceRoomDetail;
  pending: RoomAction | null;
  setPending: (action: RoomAction | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<InvoiceRoomClaimResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!detail.permissions.canClaimAccount) return null;

  const claim = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending("claim");
    try {
      setResult(
        await claimInvoiceRoomAccount({
          fullName: fullName.trim() || null,
          password: password || null,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(null);
    }
  };

  if (result) {
    return (
      <section
        className="border border-lime-300 bg-lime-50 p-5"
        aria-labelledby="claim-heading"
      >
        <h2
          id="claim-heading"
          className="flex items-center gap-2 font-extrabold text-teal-950"
        >
          <CheckCircle2 className="size-5" aria-hidden="true" />{" "}
          {result.created
            ? "Buyer workspace created"
            : "Invoice added to your buyer account"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          {result.loginRequired
            ? "Sign in with your existing account to see this invoice and future supplier documents."
            : "Your verified invoice is ready in Buyer Rails."}
        </p>
        <Button asChild className="mt-4 bg-[#0f5c52] hover:bg-[#0c4a43]">
          <a
            href={
              result.loginRequired
                ? "/login?returnTo=/buyer/"
                : result.buyerPath
            }
          >
            {result.loginRequired
              ? "Sign in to Buyer Rails"
              : "Open Buyer Rails"}
            <ArrowRight aria-hidden="true" />
          </a>
        </Button>
      </section>
    );
  }

  return (
    <section
      className="border border-lime-300 bg-lime-50 p-5"
      aria-labelledby="claim-heading"
    >
      <div className="flex gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-md bg-white text-teal-800">
          <UserRoundPlus className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2 id="claim-heading" className="font-extrabold">
            Keep every supplier invoice together
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Add this verified invoice to Buyer Rails for a permanent history and
            future invoice alerts.
          </p>
        </div>
      </div>
      {!open ? (
        <Button
          type="button"
          variant="outline"
          className="mt-4 min-h-11 border-teal-700 bg-white text-teal-900"
          onClick={() => setOpen(true)}
        >
          Add to Buyer Rails
          <ArrowRight aria-hidden="true" />
        </Button>
      ) : (
        <form onSubmit={claim} className="mt-5 space-y-4">
          <div>
            <Label htmlFor="claim-name" className="font-bold text-slate-800">
              Full name
            </Label>
            <Input
              id="claim-name"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              minLength={2}
              maxLength={160}
              autoComplete="name"
              className="mt-2 h-11 border-slate-300 bg-white"
            />
          </div>
          <div>
            <Label
              htmlFor="claim-password"
              className="font-bold text-slate-800"
            >
              New password
            </Label>
            <Input
              id="claim-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={12}
              maxLength={256}
              autoComplete="new-password"
              className="mt-2 h-11 border-slate-300 bg-white"
              aria-describedby="claim-password-help"
            />
            <p id="claim-password-help" className="mt-2 text-xs text-slate-600">
              Use at least 12 characters. Leave blank if you already have a Valo
              account.
            </p>
          </div>
          <Button
            type="submit"
            disabled={
              pending !== null || (password.length > 0 && password.length < 12)
            }
            className="min-h-11 bg-[#0f5c52] hover:bg-[#0c4a43]"
          >
            {pending === "claim" ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck aria-hidden="true" />
            )}{" "}
            Continue securely
          </Button>
        </form>
      )}
      {error && (
        <p className="mt-4 text-sm text-red-800" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export default function InvoiceRoom() {
  const [detail, setDetail] = useState<InvoiceRoomDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pending, setPending] = useState<RoomAction | null>("exchange");
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const existing = document.querySelector<HTMLMetaElement>(
      'meta[name="robots"]',
    );
    const previous = existing?.getAttribute("content") ?? null;
    const meta = existing ?? document.createElement("meta");
    if (!existing) {
      meta.name = "robots";
      document.head.append(meta);
    }
    meta.content = "noindex, nofollow, noarchive";

    return () => {
      if (!existing) {
        meta.remove();
      } else if (previous === null) {
        meta.removeAttribute("content");
      } else {
        meta.content = previous;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    const token = readAndClearRoomToken();
    setLoading(true);
    setLoadError(null);
    setPending("exchange");
    const load = token
      ? exchangeInvoiceRoomToken({ token })
      : getPublicInvoiceRoom();
    void load
      .then((result) => {
        if (active) setDetail(result);
      })
      .catch((error) => {
        if (active) setLoadError(error);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
          setPending(null);
        }
      });
    return () => {
      active = false;
    };
  }, [reloadNonce]);

  if (loading) return <LoadingRoom />;
  if (!detail || loadError)
    return (
      <UnavailableRoom
        error={loadError}
        onRetry={() => setReloadNonce((value) => value + 1)}
      />
    );

  const status = statusTone(detail);
  const StatusIcon = status.Icon;
  const due = detail.invoice.dueDate
    ? new Date(`${detail.invoice.dueDate}T23:59:59`)
    : null;
  const overdue = due
    ? due.getTime() < Date.now() && !detail.payment.settled
    : false;

  return (
    <InvoiceRoomShell>
      <main id="invoice-room-main" tabIndex={-1} className="focus:outline-none">
        <section className="bg-[#073f3a] text-white">
          <div className="mx-auto grid max-w-7xl gap-8 px-5 py-9 sm:px-8 sm:py-12 lg:grid-cols-[1fr_auto] lg:items-end">
            <div className="min-w-0">
              <p className="text-xs font-extrabold uppercase text-lime-300">
                Invoice from {detail.supplier.legalName}
              </p>
              <h1 className="landing-display mt-3 break-words text-3xl font-bold sm:text-5xl">
                {detail.invoice.invoiceNumber}
              </h1>
              <p className="mt-3 text-sm text-teal-100 sm:text-base">
                Issued to {detail.buyer.legalName} ·{" "}
                {formatDate(detail.invoice.issueDate)}
              </p>
            </div>
            <div className="lg:text-right">
              <p className="text-sm font-semibold text-teal-100">Amount due</p>
              <p className="mt-1 text-3xl font-black tabular-nums sm:text-4xl">
                {formatAmount(
                  detail.invoice.grandTotal,
                  detail.invoice.currency,
                )}
              </p>
              <span
                className={`mt-4 inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-bold ${status.className}`}
              >
                <StatusIcon className="size-4" aria-hidden="true" />{" "}
                {status.label}
              </span>
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-5 py-7 sm:px-8 sm:py-10">
          <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_23rem] lg:items-start">
            <div className="min-w-0 space-y-7">
              <section
                className="border border-slate-200 bg-white"
                aria-labelledby="invoice-document-heading"
              >
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
                  <div className="flex items-center gap-3">
                    <FileText
                      className="size-5 text-teal-700"
                      aria-hidden="true"
                    />
                    <div>
                      <h2
                        id="invoice-document-heading"
                        className="font-extrabold"
                      >
                        Invoice document
                      </h2>
                      <p className="mt-0.5 text-xs text-slate-500">
                        Verified source details
                      </p>
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm">
                    <a href="/api/public/invoice-room/pdf" download>
                      <Download aria-hidden="true" /> Download PDF
                    </a>
                  </Button>
                </div>
                <dl className="grid border-b border-slate-200 sm:grid-cols-3">
                  <div className="border-b border-slate-200 px-5 py-4 sm:border-b-0 sm:border-r sm:px-6">
                    <dt className="text-xs font-bold uppercase text-slate-500">
                      Issue date
                    </dt>
                    <dd className="mt-1 font-bold">
                      {formatDate(detail.invoice.issueDate)}
                    </dd>
                  </div>
                  <div className="border-b border-slate-200 px-5 py-4 sm:border-b-0 sm:border-r sm:px-6">
                    <dt className="text-xs font-bold uppercase text-slate-500">
                      Due date
                    </dt>
                    <dd
                      className={`mt-1 font-bold ${overdue ? "text-red-700" : ""}`}
                    >
                      {formatDate(detail.invoice.dueDate)}
                      {overdue ? " · Overdue" : ""}
                    </dd>
                  </div>
                  <div className="px-5 py-4 sm:px-6">
                    <dt className="text-xs font-bold uppercase text-slate-500">
                      Currency
                    </dt>
                    <dd className="mt-1 font-bold">
                      {detail.invoice.currency}
                    </dd>
                  </div>
                </dl>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[38rem] text-left text-sm">
                    <caption className="sr-only">Invoice line items</caption>
                    <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-500">
                      <tr>
                        <th scope="col" className="px-6 py-3">
                          Description
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          Qty
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          Unit price
                        </th>
                        <th scope="col" className="px-4 py-3 text-right">
                          VAT
                        </th>
                        <th scope="col" className="px-6 py-3 text-right">
                          Total
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {detail.lines.map((line) => (
                        <tr key={line.lineNo}>
                          <td className="px-6 py-4 font-semibold text-slate-900">
                            {line.description}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-slate-600">
                            {line.quantity}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-slate-600">
                            {formatAmount(
                              line.unitPrice,
                              detail.invoice.currency,
                            )}
                          </td>
                          <td className="px-4 py-4 text-right tabular-nums text-slate-600">
                            {Number(line.vatRate).toLocaleString("en-NG")}%
                          </td>
                          <td className="px-6 py-4 text-right font-bold tabular-nums">
                            {formatAmount(
                              String(
                                Number(line.lineExtension) +
                                  Number(line.vatAmount),
                              ),
                              detail.invoice.currency,
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <dl className="ml-auto w-full max-w-sm space-y-2 border-t border-slate-200 px-5 py-5 text-sm sm:px-6">
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">Subtotal</dt>
                    <dd className="font-semibold tabular-nums">
                      {formatAmount(
                        detail.invoice.subtotal,
                        detail.invoice.currency,
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-slate-500">VAT</dt>
                    <dd className="font-semibold tabular-nums">
                      {formatAmount(
                        detail.invoice.vatTotal,
                        detail.invoice.currency,
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base">
                    <dt className="font-extrabold">Total</dt>
                    <dd className="font-black tabular-nums">
                      {formatAmount(
                        detail.invoice.grandTotal,
                        detail.invoice.currency,
                      )}
                    </dd>
                  </div>
                </dl>
                {detail.invoice.notes && (
                  <div className="border-t border-slate-200 px-5 py-4 text-sm leading-6 text-slate-600 sm:px-6">
                    <span className="font-bold text-slate-900">
                      Invoice note:{" "}
                    </span>
                    {detail.invoice.notes}
                  </div>
                )}
              </section>

              <section
                className="border border-slate-200 bg-white p-5 sm:p-6"
                aria-labelledby="evidence-heading"
              >
                <div className="flex flex-wrap items-start justify-between gap-5">
                  <div className="flex gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-md bg-emerald-100 text-emerald-800">
                      <ShieldCheck className="size-5" aria-hidden="true" />
                    </span>
                    <div>
                      <h2 id="evidence-heading" className="font-extrabold">
                        Supplier and stamp evidence
                      </h2>
                      <p className="mt-1 text-sm text-slate-600">
                        Details captured from the immutable invoice record.
                      </p>
                    </div>
                  </div>
                  {detail.supplier.tinValidated && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-800">
                      <CheckCircle2 className="size-3.5" aria-hidden="true" />{" "}
                      TIN validated
                    </span>
                  )}
                </div>
                <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-slate-500">Legal supplier</dt>
                    <dd className="mt-1 font-bold">
                      {detail.supplier.legalName}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Supplier TIN</dt>
                    <dd className="mt-1 font-mono font-bold">
                      {detail.supplier.tin ?? "Not provided"}
                    </dd>
                  </div>
                  {detail.stamp && (
                    <>
                      <div>
                        <dt className="text-slate-500">
                          Invoice reference number (IRN)
                        </dt>
                        <dd className="mt-1 break-all font-mono text-xs font-bold">
                          {detail.stamp.irn}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">
                          Cryptographic stamp ID (CSID)
                        </dt>
                        <dd className="mt-1 break-all font-mono text-xs font-bold">
                          {detail.stamp.csid}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Stamp rail</dt>
                        <dd className="mt-1 font-bold">
                          {detail.stamp.rail} · {detail.stamp.provider}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Stamped</dt>
                        <dd className="mt-1 font-bold">
                          {formatDateTime(detail.stamp.stampedAt)}
                        </dd>
                      </div>
                    </>
                  )}
                </dl>
              </section>

              <section
                className="border border-slate-200 bg-white p-5 sm:p-6"
                aria-labelledby="activity-heading"
              >
                <div className="flex items-center gap-3">
                  <Clock3 className="size-5 text-teal-700" aria-hidden="true" />
                  <div>
                    <h2 id="activity-heading" className="font-extrabold">
                      Shared activity
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-500">
                      A time-stamped history for this secure room
                    </p>
                  </div>
                </div>
                {detail.timeline.length === 0 ? (
                  <p className="mt-5 text-sm text-slate-500">
                    No activity has been recorded yet.
                  </p>
                ) : (
                  <ol className="mt-5 space-y-0">
                    {[...detail.timeline].reverse().map((event, index) => (
                      <li
                        key={event.id}
                        className="relative flex gap-3 pb-5 last:pb-0"
                      >
                        {index < detail.timeline.length - 1 && (
                          <span
                            className="absolute left-[7px] top-4 h-full w-px bg-slate-200"
                            aria-hidden="true"
                          />
                        )}
                        <span
                          className="relative mt-1 size-4 shrink-0 rounded-full border-4 border-white bg-teal-600 ring-1 ring-teal-200"
                          aria-hidden="true"
                        />
                        <div>
                          <p className="text-sm font-bold">
                            {EVENT_LABEL[event.kind] ??
                              event.kind.replaceAll("_", " ")}
                          </p>
                          <time
                            dateTime={event.createdAt}
                            className="mt-1 block text-xs text-slate-500"
                          >
                            {formatDateTime(event.createdAt)}
                          </time>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>

            <aside
              className="space-y-5 lg:sticky lg:top-6"
              aria-label="Invoice actions"
            >
              {!detail.room.identityVerified ? (
                <VerifyPanel
                  detail={detail}
                  pending={pending}
                  setPending={setPending}
                  onVerified={setDetail}
                />
              ) : (
                <div
                  className="flex items-start gap-3 border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
                  role="status"
                >
                  <ShieldCheck
                    className="mt-0.5 size-5 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    <span className="font-extrabold">Contact verified</span>
                    <br />
                    Sensitive actions are unlocked for this session.
                  </span>
                </div>
              )}
              {detail.room.identityVerified && (
                <ResponsePanel
                  detail={detail}
                  pending={pending}
                  setPending={setPending}
                  onChange={setDetail}
                />
              )}
              {detail.room.identityVerified && (
                <PaymentPanel
                  detail={detail}
                  pending={pending}
                  setPending={setPending}
                  onChange={setDetail}
                />
              )}
              {detail.room.identityVerified && (
                <ClaimPanel
                  detail={detail}
                  pending={pending}
                  setPending={setPending}
                />
              )}
              <section
                className="border border-slate-200 bg-white p-5 text-sm text-slate-600"
                aria-labelledby="security-heading"
              >
                <h2
                  id="security-heading"
                  className="flex items-center gap-2 font-extrabold text-slate-900"
                >
                  <LockKeyhole
                    className="size-4 text-teal-700"
                    aria-hidden="true"
                  />{" "}
                  Link security
                </h2>
                <p className="mt-2 leading-6">
                  This room expires {formatDate(detail.room.expiresAt)}. Valo
                  never asks for your banking password or one-time bank PIN.
                </p>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </InvoiceRoomShell>
  );
}
