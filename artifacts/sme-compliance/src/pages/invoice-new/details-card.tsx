import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHT_CATEGORY_LABELS } from "@workspace/format/wht-copy";
import { CustomerDirectoryPicker } from "@/components/customer-directory-picker";
import { FieldError, invalidClass } from "@/components/field-error";
import { Plus } from "lucide-react";
import { CURRENCIES, NO_WHT } from "./helpers";
import type { InvoiceNewFormState } from "./use-invoice-new-form";

type DetailsProps = Pick<
  InvoiceNewFormState,
  | "draft"
  | "setDraft"
  | "showErrors"
  | "errors"
  | "me"
  | "selectedBuyer"
  | "tinGuidance"
> & { onAddCustomer: () => void };

/**
 * The Customer field: the directory picker, "Add customer", the validation
 * error and the missing-TIN note (the TIN never blocks a draft).
 */
function CustomerField({
  draft,
  setDraft,
  showErrors,
  errors,
  me,
  selectedBuyer,
  tinGuidance,
  onAddCustomer,
}: DetailsProps) {
  return (
    <div>
      <Label htmlFor="buyer-select">Customer</Label>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <CustomerDirectoryPicker
            id="buyer-select"
            value={draft.buyerPartyId}
            onChange={(buyerPartyId) =>
              setDraft((d) => ({ ...d, buyerPartyId }))
            }
            excludeId={me?.clientPartyId ?? undefined}
            invalid={showErrors && !!errors.buyerPartyId}
            describedBy={
              showErrors && errors.buyerPartyId
                ? "buyer-select-error"
                : selectedBuyer && !selectedBuyer.tin
                  ? "buyer-tin-note"
                  : undefined
            }
          />
        </div>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={onAddCustomer}
          data-testid="button-add-customer"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
          Add customer
        </Button>
      </div>
      {showErrors && errors.buyerPartyId && (
        <FieldError id="buyer-select-error">{errors.buyerPartyId}</FieldError>
      )}
      {selectedBuyer && !selectedBuyer.tin && (
        <p
          id="buyer-tin-note"
          className="text-sm mt-1 text-amber-700 dark:text-amber-400"
        >
          {tinGuidance} You can still save this invoice as a draft — it cannot
          be submitted for stamping until the TIN is added.
        </p>
      )}
    </div>
  );
}

/** The id=invoice-details card: number, customer, dates, currency, WHT. */
export function InvoiceDetailsCard({
  draft,
  setDraft,
  showErrors,
  errors,
  me,
  selectedBuyer,
  tinGuidance,
  onAddCustomer,
}: DetailsProps) {
  return (
    <Card id="invoice-details" className="scroll-mt-24">
      <CardHeader>
        <CardTitle>Details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label htmlFor="invoice-number">Invoice number</Label>
          <Input
            id="invoice-number"
            value={draft.invoiceNumber}
            onChange={(e) =>
              setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))
            }
            placeholder="INV-1006"
            aria-invalid={showErrors && !!errors.invoiceNumber}
            aria-describedby={
              showErrors && errors.invoiceNumber
                ? "invoice-number-error"
                : undefined
            }
            className={invalidClass(showErrors && !!errors.invoiceNumber)}
          />
          {showErrors && errors.invoiceNumber && (
            <FieldError id="invoice-number-error">
              {errors.invoiceNumber}
            </FieldError>
          )}
        </div>
        <CustomerField
          draft={draft}
          setDraft={setDraft}
          showErrors={showErrors}
          errors={errors}
          me={me}
          selectedBuyer={selectedBuyer}
          tinGuidance={tinGuidance}
          onAddCustomer={onAddCustomer}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="issue-date">Issue date</Label>
            <Input
              id="issue-date"
              type="date"
              value={draft.issueDate}
              onChange={(e) =>
                setDraft((d) => ({ ...d, issueDate: e.target.value }))
              }
              aria-invalid={showErrors && !!errors.issueDate}
              aria-describedby={
                showErrors && errors.issueDate ? "issue-date-error" : undefined
              }
              className={invalidClass(showErrors && !!errors.issueDate)}
            />
            {showErrors && errors.issueDate && (
              <FieldError id="issue-date-error">{errors.issueDate}</FieldError>
            )}
          </div>
          <div>
            <Label htmlFor="due-date">Due date (optional)</Label>
            <Input
              id="due-date"
              type="date"
              value={draft.dueDate}
              onChange={(e) =>
                setDraft((d) => ({ ...d, dueDate: e.target.value }))
              }
            />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="currency-select">Currency</Label>
            <select
              id="currency-select"
              value={draft.currency}
              onChange={(e) =>
                setDraft((d) => ({ ...d, currency: e.target.value }))
              }
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              data-testid="select-currency"
            >
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          {draft.currency !== "NGN" && (
            <div>
              <Label htmlFor="fx-rate">Exchange rate (₦ per unit)</Label>
              <Input
                id="fx-rate"
                inputMode="decimal"
                value={draft.fxRateToNgn}
                placeholder="e.g. 1650.00"
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    fxRateToNgn: e.target.value,
                  }))
                }
                data-testid="input-fx-rate"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used to fold this invoice into your naira VAT position.
              </p>
            </div>
          )}
        </div>
        <div>
          <Label htmlFor="wht-category-select">WHT category</Label>
          {/* A human picks the category — nothing is ever
                    pre-selected; "No WHT" is the default and omits the
                    field from the payload. The % in each label is wording
                    from the shared catalogue, not arithmetic. */}
          <Select
            value={draft.whtCategory || NO_WHT}
            onValueChange={(v) =>
              setDraft((d) => ({
                ...d,
                whtCategory: v === NO_WHT ? "" : v,
              }))
            }
          >
            <SelectTrigger
              id="wht-category-select"
              data-testid="select-wht-category"
            >
              <SelectValue placeholder="No WHT" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_WHT}>No WHT</SelectItem>
              {Object.entries(WHT_CATEGORY_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1">
            If your customer withholds tax on this invoice, pick the deduction
            type — the customer owes you a credit note for it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
