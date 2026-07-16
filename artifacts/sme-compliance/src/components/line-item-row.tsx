import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError, invalidClass } from "@/components/field-error";
import { formatNaira } from "@/lib/format";
import { lineTotal, type LineDraft } from "@/lib/invoice-lines";
import { Trash2 } from "lucide-react";

/**
 * Per-field validation messages for one row. Omit the prop entirely (the
 * recurring dialog validates only on submit-enable) and no error plumbing is
 * rendered; pass it (the invoice form) and each present message wires
 * aria-invalid/aria-describedby plus the inline FieldError.
 */
export interface LineRowErrors {
  description?: string;
  quantity?: string;
  unitPrice?: string;
}

/**
 * One editable invoice line: description + remove control, the Qty / Unit
 * price / VAT grid, and (for the invoice form) the per-line total. The
 * `line-{i}-*` input ids are load-bearing — the e2e journeys and the invoice
 * form's scroll-to-first-error both target them.
 */
export function LineItemRow({
  index,
  line,
  onPatch,
  removable,
  onRemove,
  errors,
  showTotal = false,
  buttonType,
}: {
  index: number;
  line: LineDraft;
  onPatch: (patch: Partial<LineDraft>) => void;
  removable: boolean;
  onRemove: () => void;
  errors?: LineRowErrors;
  showTotal?: boolean;
  /** The recurring dialog pins type="button"; the invoice form leaves it unset. */
  buttonType?: "button";
}) {
  const i = index;
  const descBad = !!errors?.description;
  const qtyBad = !!errors?.quantity;
  const priceBad = !!errors?.unitPrice;
  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <Label htmlFor={`line-${i}-description`} className="sr-only">
            Line {i + 1} description
          </Label>
          <Input
            id={`line-${i}-description`}
            placeholder="Description"
            value={line.description}
            onChange={(e) => onPatch({ description: e.target.value })}
            aria-invalid={errors ? descBad : undefined}
            aria-describedby={
              descBad ? `line-${i}-description-error` : undefined
            }
            className={invalidClass(descBad)}
          />
          {descBad && (
            <FieldError id={`line-${i}-description-error`}>
              {errors!.description!}
            </FieldError>
          )}
        </div>
        {removable && (
          <Button
            type={buttonType}
            variant="ghost"
            size="icon"
            aria-label="Remove line item"
            onClick={onRemove}
          >
            <Trash2 className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label htmlFor={`line-${i}-quantity`} className="text-xs">
            Qty
          </Label>
          <Input
            id={`line-${i}-quantity`}
            type="number"
            min="0"
            step="any"
            inputMode="decimal"
            value={line.quantity}
            onChange={(e) => onPatch({ quantity: e.target.value })}
            aria-invalid={errors ? qtyBad : undefined}
            aria-describedby={qtyBad ? `line-${i}-quantity-error` : undefined}
            className={invalidClass(qtyBad)}
          />
          {qtyBad && (
            <FieldError id={`line-${i}-quantity-error`}>
              {errors!.quantity!}
            </FieldError>
          )}
        </div>
        <div>
          <Label htmlFor={`line-${i}-unit-price`} className="text-xs">
            Unit price
          </Label>
          <Input
            id={`line-${i}-unit-price`}
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={line.unitPrice}
            onChange={(e) => onPatch({ unitPrice: e.target.value })}
            aria-invalid={errors ? priceBad : undefined}
            aria-describedby={
              priceBad ? `line-${i}-unit-price-error` : undefined
            }
            className={invalidClass(priceBad)}
          />
          {priceBad && (
            <FieldError id={`line-${i}-unit-price-error`}>
              {errors!.unitPrice!}
            </FieldError>
          )}
        </div>
        <div>
          <Label htmlFor={`line-${i}-vat`} className="text-xs">
            VAT rate
          </Label>
          <Select
            value={line.vatRate}
            onValueChange={(v) => onPatch({ vatRate: v })}
          >
            <SelectTrigger id={`line-${i}-vat`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* An invoice seeded from saved data may legally carry a
                  non-catalogue rate (the server accepts any fraction in
                  [0,1)); surface it so the select never renders blank and
                  the value survives an untouched round-trip. */}
              {line.vatRate &&
                Number.isFinite(Number(line.vatRate)) &&
                !["0.075", "0"].includes(line.vatRate) && (
                  <SelectItem value={line.vatRate}>
                    {`${Number((Number(line.vatRate) * 100).toFixed(4))}% (as saved)`}
                  </SelectItem>
                )}
              <SelectItem value="0.075">7.5% standard</SelectItem>
              <SelectItem value="0">0% exempt</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {showTotal && (
        <div className="text-right text-sm text-muted-foreground tabular-nums">
          Line total {formatNaira(lineTotal(line).total)}
        </div>
      )}
    </div>
  );
}
