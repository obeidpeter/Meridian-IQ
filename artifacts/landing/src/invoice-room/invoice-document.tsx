import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { Download, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAmount, formatDate } from "./helpers";

export function InvoiceDocument({ detail }: { detail: InvoiceRoomDetail }) {
  const due = detail.invoice.dueDate
    ? new Date(`${detail.invoice.dueDate}T23:59:59`)
    : null;
  const overdue = due
    ? due.getTime() < Date.now() && !detail.payment.settled
    : false;

  return (
    <section
      className="border border-slate-200 bg-white"
      aria-labelledby="invoice-document-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-3">
          <FileText className="size-5 text-teal-700" aria-hidden="true" />
          <div>
            <h2 id="invoice-document-heading" className="font-extrabold">
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
          <dd className={`mt-1 font-bold ${overdue ? "text-red-700" : ""}`}>
            {formatDate(detail.invoice.dueDate)}
            {overdue ? " · Overdue" : ""}
          </dd>
        </div>
        <div className="px-5 py-4 sm:px-6">
          <dt className="text-xs font-bold uppercase text-slate-500">
            Currency
          </dt>
          <dd className="mt-1 font-bold">{detail.invoice.currency}</dd>
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
                  {formatAmount(line.unitPrice, detail.invoice.currency)}
                </td>
                <td className="px-4 py-4 text-right tabular-nums text-slate-600">
                  {Number(line.vatRate).toLocaleString("en-NG")}%
                </td>
                <td className="px-6 py-4 text-right font-bold tabular-nums">
                  {formatAmount(
                    String(Number(line.lineExtension) + Number(line.vatAmount)),
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
            {formatAmount(detail.invoice.subtotal, detail.invoice.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-slate-500">VAT</dt>
          <dd className="font-semibold tabular-nums">
            {formatAmount(detail.invoice.vatTotal, detail.invoice.currency)}
          </dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-slate-200 pt-3 text-base">
          <dt className="font-extrabold">Total</dt>
          <dd className="font-black tabular-nums">
            {formatAmount(detail.invoice.grandTotal, detail.invoice.currency)}
          </dd>
        </div>
      </dl>
      {detail.invoice.notes && (
        <div className="border-t border-slate-200 px-5 py-4 text-sm leading-6 text-slate-600 sm:px-6">
          <span className="font-bold text-slate-900">Invoice note: </span>
          {detail.invoice.notes}
        </div>
      )}
    </section>
  );
}
