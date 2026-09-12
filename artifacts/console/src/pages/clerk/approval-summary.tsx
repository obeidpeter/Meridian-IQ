import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { Firm, Party } from "@workspace/api-client-react";
import {
  authorityLabel,
  noticeTypeLabel,
  vatPercentInvalid,
  type ApproveForm,
  type NoticeApproveForm,
} from "@/pages/clerk-shared";

type Parties = { firms: Firm[] | undefined; parties: Party[] | undefined };

function ApprovalSummary({
  id,
  outcome,
  rows,
  children,
}: {
  id: string;
  outcome: string;
  rows: [string, string][];
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label="Approval summary"
      className="space-y-3 border-y py-4"
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        Approval summary
      </h3>
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3"
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium [overflow-wrap:anywhere]">
              {value || "Not selected"}
            </dd>
          </div>
        ))}
      </dl>
      {children}
      <p className="text-sm leading-relaxed">{outcome}</p>
    </section>
  );
}

export function InvoiceApprovalSummary({
  form,
  firms,
  parties,
}: Parties & { form: ApproveForm }) {
  return (
    <ApprovalSummary
      id="invoice-approval-summary"
      outcome="Approval creates one draft invoice using the reviewed values. It is not submitted or filed. Submission requires a separate human action."
      rows={[
        ["Firm", firms?.find((firm) => firm.id === form.firmId)?.name ?? ""],
        [
          "Supplier",
          parties?.find((party) => party.id === form.supplierPartyId)
            ?.legalName ?? "",
        ],
        [
          "Customer",
          parties?.find((party) => party.id === form.buyerPartyId)?.legalName ??
            "",
        ],
        ["Invoice number", form.invoiceNumber.trim()],
        ["Issue date", form.issueDate],
        ["Due date", form.dueDate || "Not set"],
        [
          "Invoice items",
          `${form.lines.length} ${form.lines.length === 1 ? "item" : "items"}`,
        ],
        ["Currency", form.currency],
        ["Category", form.category.toUpperCase()],
      ]}
    >
      <ol className="divide-y border-y" aria-label="Reviewed invoice items">
        {form.lines.map((line, index) => (
          <li
            key={index}
            className="space-y-2 py-3 text-sm"
            data-testid={`summary-line-${index}`}
          >
            <p className="font-semibold whitespace-pre-wrap [overflow-wrap:anywhere]">
              {index + 1}.{" "}
              {line.description.trim() || "Description not entered"}
            </p>
            <dl className="grid grid-cols-2 gap-2 [overflow-wrap:anywhere]">
              <dt className="text-muted-foreground">Quantity</dt>
              <dd>{line.quantity.trim() || "Not entered"}</dd>
              <dt className="text-muted-foreground">
                Unit price ({form.currency.trim() || "currency not set"})
              </dt>
              <dd>{line.unitPrice.trim() || "Not entered"}</dd>
              <dt className="text-muted-foreground">VAT rate</dt>
              <dd>
                {vatPercentInvalid(line.vatRate)
                  ? line.vatRate.trim() || "Not entered"
                  : `${line.vatRate.replace("%", "").trim()}%`}
                {vatPercentInvalid(line.vatRate) && (
                  <span className="block text-destructive">Check VAT rate</span>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ol>
      {form.lines.length === 0 && (
        <p className="text-sm text-destructive">No invoice items to approve.</p>
      )}
    </ApprovalSummary>
  );
}

export function NoticeApprovalSummary({
  form,
  firms,
  parties,
}: Parties & { form: NoticeApproveForm }) {
  return (
    <ApprovalSummary
      id="notice-approval-summary"
      outcome="Approval records one open response obligation for this client and deadline. It does not create an invoice, send a response or file anything."
      rows={[
        ["Firm", firms?.find((firm) => firm.id === form.firmId)?.name ?? ""],
        [
          "Client",
          parties?.find((party) => party.id === form.clientPartyId)
            ?.legalName ?? "",
        ],
        [
          "Notice type",
          form.noticeType ? noticeTypeLabel(form.noticeType) : "",
        ],
        ["Authority", form.authority ? authorityLabel(form.authority) : ""],
        ["Reference", form.reference.trim() || "Not set"],
        ["Response due", form.responseDueDate],
      ]}
    />
  );
}
