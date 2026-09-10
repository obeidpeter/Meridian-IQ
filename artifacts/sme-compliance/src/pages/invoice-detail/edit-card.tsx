// The invoice detail page's fix form and its edit card (R126 moved them out
// of the page shell). The shell creates the connected form element exactly
// once and hands it to whichever card shows it — the failure card for a
// failed invoice, the edit card otherwise — so both keep the identical
// child.
import type { ReactNode } from "react";
import type { Invoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Wrench } from "lucide-react";
import { FixInvoiceForm } from "./fix-form";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function ConnectedFixForm({
  state,
  invoice,
  abilities,
}: {
  state: InvoiceDetailState;
  invoice: Invoice;
  abilities: InvoiceAbilities;
}) {
  const {
    fix,
    setFix,
    data,
    tone,
    fixConflict,
    setFixConflict,
    showFixErrors,
    fixErrors,
    openFix,
    handleFixResubmit,
    updateInvoice,
    validate,
    submit,
  } = state;
  const { focus } = abilities;
  // The shell only renders this element while the form is open; the guard
  // narrows the bag's nullable draft for the form's props.
  if (!fix) return null;
  return (
    <FixInvoiceForm
      fix={fix}
      setFix={setFix}
      invoice={invoice}
      lines={data?.lines ?? []}
      tone={tone}
      fixConflict={fixConflict}
      setFixConflict={setFixConflict}
      showFixErrors={showFixErrors}
      fixErrors={fixErrors}
      focus={focus}
      onReload={openFix}
      onResubmit={handleFixResubmit}
      pending={
        updateInvoice.isPending || validate.isPending || submit.isPending
      }
    />
  );
}

export function EditInvoiceCard({ fixForm }: { fixForm: ReactNode }) {
  return (
    <Card data-testid="card-edit-invoice">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wrench className="w-4 h-4" aria-hidden="true" /> Edit invoice
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm">{fixForm}</CardContent>
    </Card>
  );
}
