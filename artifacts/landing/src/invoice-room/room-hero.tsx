import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { formatAmount, formatDate, statusTone } from "./helpers";

export function RoomHero({ detail }: { detail: InvoiceRoomDetail }) {
  const status = statusTone(detail);
  const StatusIcon = status.Icon;

  return (
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
            {formatAmount(detail.invoice.grandTotal, detail.invoice.currency)}
          </p>
          <span
            className={`mt-4 inline-flex min-h-8 items-center gap-2 rounded-full border px-3 text-xs font-bold ${status.className}`}
          >
            <StatusIcon className="size-4" aria-hidden="true" /> {status.label}
          </span>
        </div>
      </div>
    </section>
  );
}
