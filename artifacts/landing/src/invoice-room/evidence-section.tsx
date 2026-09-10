import type { InvoiceRoomDetail } from "@workspace/api-client-react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { formatDateTime } from "./helpers";

export function EvidenceSection({ detail }: { detail: InvoiceRoomDetail }) {
  return (
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
            <CheckCircle2 className="size-3.5" aria-hidden="true" /> TIN
            validated
          </span>
        )}
      </div>
      <dl className="mt-5 grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-slate-500">Legal supplier</dt>
          <dd className="mt-1 font-bold">{detail.supplier.legalName}</dd>
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
              <dt className="text-slate-500">Invoice reference number (IRN)</dt>
              <dd className="mt-1 break-all font-mono text-xs font-bold">
                {detail.stamp.irn}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Cryptographic stamp ID (CSID)</dt>
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
  );
}
