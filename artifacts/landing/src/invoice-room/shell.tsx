import {
  Clock3,
  Loader2,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "./helpers";

export function InvoiceRoomShell({ children }: { children: React.ReactNode }) {
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
                Invoice room
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
          <p>Valo · Invoice details, buyer responses and payment records.</p>
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

export function LoadingRoom() {
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
            Opening your invoice
          </h1>
          <p className="mt-3 text-slate-600">
            Checking the link and loading the invoice details.
          </p>
        </div>
      </main>
    </InvoiceRoomShell>
  );
}

export function UnavailableRoom({
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
              ? "This invoice link is no longer active"
              : "We could not open this invoice"}
          </h1>
          <p className="mt-3 leading-7 text-slate-600">{errorMessage(error)}</p>
          <p className="mt-3 text-sm text-slate-500">
            Ask the supplier for a new invoice link. Links can expire or be
            cancelled by the supplier.
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
