import type { Invoice, InvoiceLine } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import type { LineDraft } from "@/lib/invoice-lines";

type EditableSnapshot = {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  lines: LineDraft[];
};

export function InvoiceConflict({
  draft,
  saved,
  lines,
  onReload,
  onKeep,
}: {
  draft: EditableSnapshot;
  saved: Invoice;
  lines: InvoiceLine[];
  onReload: () => void;
  onKeep: () => void;
}) {
  const lineText = (
    values: readonly {
      description: string;
      quantity: string;
      unitPrice: string;
      vatRate: string;
    }[],
  ) =>
    values
      .map(
        (line) =>
          `${line.description}: ${line.quantity} x ${line.unitPrice}; VAT ${line.vatRate}`,
      )
      .join("\n");
  const comparisons = [
    ["Invoice number", saved.invoiceNumber, draft.invoiceNumber],
    ["Issue date", saved.issueDate, draft.issueDate],
    ["Due date", saved.dueDate ?? "", draft.dueDate],
    ["Line items", lineText(lines), lineText(draft.lines)],
  ];
  return (
    <section
      aria-labelledby="invoice-conflict-heading"
      className="space-y-3 border-l-4 border-amber-500 pl-3"
    >
      <div role="alert">
        <h3 id="invoice-conflict-heading" className="font-semibold">
          Invoice changed
        </h3>
        <p className="text-sm text-muted-foreground">
          Your edits are preserved. Saved version {saved.contentRevision} is
          shown below. Keeping your edits returns them to the form; review and
          save them separately.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left text-sm">
          <caption className="sr-only">
            Saved invoice compared with your edits
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-1/5 p-2">
                Field
              </th>
              <th scope="col" className="p-2">
                Saved
              </th>
              <th scope="col" className="p-2">
                Your edits
              </th>
            </tr>
          </thead>
          <tbody>
            {comparisons.map(([label, oldValue, newValue]) => (
              <tr key={label} className="border-t">
                <th
                  scope="row"
                  className="p-2 align-top font-medium break-words"
                >
                  {label}
                </th>
                <td className="whitespace-pre-wrap break-words p-2 align-top">
                  {oldValue || "Not set"}
                </td>
                <td className="whitespace-pre-wrap break-words p-2 align-top">
                  {newValue || "Not set"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={onReload}>
          Reload saved version
        </Button>
        <Button type="button" onClick={onKeep}>
          Keep my edits
        </Button>
      </div>
    </section>
  );
}
