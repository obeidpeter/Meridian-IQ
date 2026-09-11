import { useState, type FormEvent } from "react";
import { claimInvoiceRoomAccount } from "@workspace/api-client-react";
import type {
  InvoiceRoomClaimResult,
  InvoiceRoomDetail,
} from "@workspace/api-client-react";
import {
  ArrowRight,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  UserRoundPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage, type RoomAction } from "./helpers";

export function ClaimPanel({
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
            ? "Sign in with your existing account to see this invoice in your buyer workspace."
            : "This invoice is now in your buyer workspace."}
        </p>
        <Button asChild className="mt-4 bg-[#0f5c52] hover:bg-[#0c4a43]">
          <a
            href={
              result.loginRequired
                ? "/login?returnTo=/buyer/"
                : result.buyerPath
            }
          >
            {result.loginRequired ? "Sign in" : "Open buyer workspace"}
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
            Keep this invoice in your account
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Add this invoice to your buyer workspace to keep its history with
            your other supplier invoices.
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
          Add to buyer workspace
          <ArrowRight aria-hidden="true" />
        </Button>
      ) : (
        <form onSubmit={claim} className="mt-5 space-y-4">
          <div>
            <Label htmlFor="claim-name" className="font-bold text-slate-800">
              Full name (optional)
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
            Add invoice
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
