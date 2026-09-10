import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { LineItemRow } from "@/components/line-item-row";
import { formatNaira } from "@/lib/format";
import { emptyLine } from "@/lib/invoice-lines";
import { Plus } from "lucide-react";
import type { InvoiceNewFormState } from "./use-invoice-new-form";

/** The id=invoice-lines card: frequent-item chips and one row per line. */
export function InvoiceLinesCard({
  draft,
  setDraft,
  frequentItems,
  addFrequentItem,
  setLine,
  showErrors,
  errors,
}: Pick<
  InvoiceNewFormState,
  | "draft"
  | "setDraft"
  | "frequentItems"
  | "addFrequentItem"
  | "setLine"
  | "showErrors"
  | "errors"
>) {
  return (
    <Card id="invoice-lines" className="scroll-mt-24">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Line items</CardTitle>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              lines: [...d.lines, emptyLine()],
            }))
          }
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {(frequentItems ?? []).length > 0 && (
          <div className="space-y-1.5" data-testid="frequent-items">
            <p className="text-xs text-muted-foreground">
              Frequent items — from your own invoices; click to add a prefilled
              line, then check the price.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(frequentItems ?? []).slice(0, 8).map((item) => (
                <Button
                  key={item.key}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => addFrequentItem(item)}
                  data-testid={`frequent-item-${item.key}`}
                >
                  {item.description} · {formatNaira(item.medianUnitPrice)}
                </Button>
              ))}
            </div>
          </div>
        )}
        {draft.lines.map((l, i) => (
          <LineItemRow
            key={i}
            index={i}
            line={l}
            onPatch={(patch) => setLine(i, patch)}
            removable={draft.lines.length > 1}
            onRemove={() =>
              setDraft((d) => ({
                ...d,
                lines: d.lines.filter((_, idx) => idx !== i),
              }))
            }
            errors={{
              description: showErrors ? errors[`line-${i}-desc`] : undefined,
              quantity: showErrors ? errors[`line-${i}-qty`] : undefined,
              unitPrice: showErrors ? errors[`line-${i}-price`] : undefined,
            }}
            showTotal
            currency={draft.currency}
          />
        ))}
      </CardContent>
    </Card>
  );
}
