import { useState, type FormEvent } from "react";
import {
  requestInvoiceRoomOtp,
  verifyInvoiceRoomOtp,
} from "@workspace/api-client-react";
import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import {
  AlertCircle,
  Fingerprint,
  Loader2,
  LockKeyhole,
  Mail,
  MessageCircle,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, type RoomAction } from "./helpers";

export function VerifyPanel({
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
