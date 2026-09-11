import type { Dispatch, SetStateAction } from "react";
import type { Invoice } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LineItemRow } from "@/components/line-item-row";
import { FieldError } from "@/components/field-error";
import { InvoiceConflict } from "@/components/invoice-conflict";
import {
  emptyLine,
  lineTotals,
  updateLineAt,
  type LineDraft,
} from "@/lib/invoice-lines";
import { Plus } from "lucide-react";
import { formatAmount, pillClasses, type statusTone } from "@/lib/format";

// "Fix & resubmit": an editable copy of a failed or draft invoice's content,
// seeded by the shell when the form opens and closed by setting it to null.
export type FixDraft = {
  expectedRevision: number;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  lines: LineDraft[];
};

// The fix form (R120 moved it out of the InvoiceDetail shell). The shell
// owns the draft, the conflict flag, the error visibility and the mutation
// pending state; this renders them and reports the two actions back.
export function FixInvoiceForm({
  fix,
  setFix,
  invoice,
  lines,
  tone,
  fixConflict,
  setFixConflict,
  showFixErrors,
  fixErrors,
  focus,
  onReload,
  onResubmit,
  pending,
}: {
  fix: FixDraft;
  setFix: Dispatch<SetStateAction<FixDraft | null>>;
  invoice: Invoice;
  lines: Parameters<typeof InvoiceConflict>[0]["lines"];
  tone: ReturnType<typeof statusTone>;
  fixConflict: boolean;
  setFixConflict: Dispatch<SetStateAction<boolean>>;
  showFixErrors: boolean;
  fixErrors: Record<string, string>;
  focus: ReadonlyArray<string>;
  onReload: () => void;
  onResubmit: () => void;
  pending: boolean;
}) {
  return (
    <div
      className="rounded-lg border bg-background p-3 space-y-3"
      data-testid="fix-form"
    >
      <p className="font-medium">
        {tone === "failed"
          ? "Correct the flagged details, then resubmit"
          : "Correct the details, then submit"}
      </p>
      {fixConflict && (
        <InvoiceConflict
          draft={fix}
          saved={invoice}
          lines={lines}
          onReload={onReload}
          onKeep={() => {
            setFix((current) =>
              current
                ? { ...current, expectedRevision: invoice.contentRevision }
                : null,
            );
            setFixConflict(false);
          }}
        />
      )}
      {focus.includes("parties") && (
        <p className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 p-2 text-amber-800 dark:text-amber-300">
          The e-invoicing service rejected a Tax Identification Number (TIN).
          TINs are saved in the business and customer records, not on this
          invoice. Ask your accountant to correct the record, or request help
          below, then try submitting again.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <Label
            htmlFor="fix-invoice-number"
            className="flex items-center gap-2"
          >
            Invoice number
            {focus.includes("invoiceNumber") && (
              <span className={pillClasses("amber")}>flagged</span>
            )}
          </Label>
          <Input
            id="fix-invoice-number"
            value={fix.invoiceNumber}
            onChange={(e) =>
              setFix((f) => f && { ...f, invoiceNumber: e.target.value })
            }
            className="mt-1"
          />
          {showFixErrors && fixErrors.invoiceNumber && (
            <FieldError id="fix-invoice-number-error">
              {fixErrors.invoiceNumber}
            </FieldError>
          )}
        </div>
        <div>
          <Label htmlFor="fix-issue-date" className="flex items-center gap-2">
            Issue date
            {focus.includes("invoice") && (
              <span className={pillClasses("amber")}>flagged</span>
            )}
          </Label>
          <Input
            id="fix-issue-date"
            type="date"
            value={fix.issueDate}
            onChange={(e) =>
              setFix((f) => f && { ...f, issueDate: e.target.value })
            }
            className="mt-1"
          />
          {showFixErrors && fixErrors.issueDate && (
            <FieldError id="fix-issue-date-error">
              {fixErrors.issueDate}
            </FieldError>
          )}
        </div>
        <div>
          <Label htmlFor="fix-due-date">Due date (optional)</Label>
          <Input
            id="fix-due-date"
            type="date"
            value={fix.dueDate}
            onChange={(e) =>
              setFix((f) => f && { ...f, dueDate: e.target.value })
            }
            className="mt-1"
          />
        </div>
      </div>
      <div className="space-y-2">
        <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          Line items
          {focus.includes("lines") && (
            <span className={pillClasses("amber")}>flagged</span>
          )}
        </p>
        {fix.lines.map((line, i) => (
          <LineItemRow
            key={i}
            index={i}
            line={line}
            onPatch={(patch) =>
              setFix(
                (f) =>
                  f && {
                    ...f,
                    lines: updateLineAt(f.lines, i, patch),
                  },
              )
            }
            removable={fix.lines.length > 1}
            onRemove={() =>
              setFix(
                (f) =>
                  f && {
                    ...f,
                    lines: f.lines.filter((_, j) => j !== i),
                  },
              )
            }
            errors={
              showFixErrors
                ? {
                    description: fixErrors[`line-${i}-desc`],
                    quantity: fixErrors[`line-${i}-qty`],
                    unitPrice: fixErrors[`line-${i}-price`],
                  }
                : undefined
            }
            showTotal
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            setFix((f) => f && { ...f, lines: [...f.lines, emptyLine()] })
          }
        >
          <Plus className="w-4 h-4 mr-2" aria-hidden="true" /> Add line
        </Button>
        <p className="text-right text-muted-foreground tabular-nums">
          Total{" "}
          {formatAmount(
            lineTotals(fix.lines).net + lineTotals(fix.lines).vat,
            invoice.currency,
          )}
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={onResubmit}
          disabled={fixConflict || pending}
          data-testid="button-fix-resubmit"
        >
          {pending
            ? tone === "failed"
              ? "Resubmitting…"
              : "Submitting…"
            : tone === "failed"
              ? "Save & resubmit"
              : "Save & submit"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFix(null)}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
