import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { formatNaira } from "@/lib/format";
import { BULK_LIMIT } from "./constants";
import type { ConfirmationsPageState } from "./use-confirmations-page";

export function BulkActionBar({ state }: { state: ConfirmationsPageState }) {
  const {
    selected,
    selectAllCapped,
    bulkMethod,
    setBulkMethod,
    bulkNoSetOff,
    setBulkNoSetOff,
    overLimit,
    bulk,
    selectedTotal,
    bulkMethodLabel,
    selectedSupplierCount,
    runBulk,
  } = state;
  return (
    <div
      className="mb-4 rounded-md border bg-muted/40 p-3 space-y-2"
      data-testid="bar-bulk-actions"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p
          className="text-sm font-semibold tabular-nums"
          data-testid="text-bulk-selected"
        >
          {selected.size} selected
          {selectAllCapped && (
            <span className="font-normal text-muted-foreground">
              {" "}
              (bulk limit)
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Label htmlFor="bulk-method" className="text-sm">
            Method
          </Label>
          <Select value={bulkMethod} onValueChange={setBulkMethod}>
            <SelectTrigger
              id="bulk-method"
              className="h-9 w-32"
              data-testid="select-bulk-method"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="portal">Portal</SelectItem>
              <SelectItem value="email">Email</SelectItem>
              <SelectItem value="phone">Phone</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            className="size-6 shrink-0"
            id="bulk-no-set-off"
            checked={bulkNoSetOff}
            onCheckedChange={(v) => setBulkNoSetOff(v === true)}
            data-testid="checkbox-bulk-no-set-off"
          />
          <Label
            htmlFor="bulk-no-set-off"
            className="text-sm font-normal leading-snug"
          >
            We acknowledge no set-off will be applied against these invoices
          </Label>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              disabled={overLimit || bulk.isPending}
              data-testid="button-bulk-confirm"
            >
              {bulk.isPending ? (
                <>
                  <Spinner className="mr-2 size-4" /> Confirming…
                </>
              ) : (
                "Confirm selected"
              )}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Confirm {selected.size}{" "}
                {selected.size === 1 ? "invoice" : "invoices"}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Review the value, response method and supplier impact before
                creating a permanent confirmation record.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-3 rounded-md border bg-muted/30 p-4 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Total value</p>
                <p
                  className="mt-1 font-semibold tabular-nums"
                  data-testid="text-bulk-dialog-total"
                >
                  {formatNaira(selectedTotal)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Method</p>
                <p
                  className="mt-1 font-semibold"
                  data-testid="text-bulk-dialog-method"
                >
                  {bulkMethodLabel}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Suppliers</p>
                <p
                  className="mt-1 font-semibold tabular-nums"
                  data-testid="text-bulk-dialog-suppliers"
                >
                  {selectedSupplierCount}
                </p>
              </div>
            </div>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                Each supplier will be notified of the recorded response. The
                confirmation stores who responded, when, and by which method.
              </p>
              {bulkNoSetOff && (
                <p
                  className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
                  data-testid="text-bulk-dialog-no-set-off"
                >
                  You are also recording that no set-off will be applied. This
                  strengthens the supplier&apos;s financeability evidence by
                  documenting the receivable without a declared offset; it does
                  not guarantee financing.
                </p>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-bulk">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={runBulk}
                disabled={bulk.isPending}
                data-testid="button-confirm-bulk"
              >
                Confirm invoices
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {overLimit && (
        <p className="text-xs text-destructive" data-testid="text-bulk-limit">
          Bulk confirm handles up to {BULK_LIMIT} invoices at a time — narrow
          your selection.
        </p>
      )}
    </div>
  );
}
