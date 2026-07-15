import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useGetMe,
  useListParties,
  useListRecurringInvoices,
  useCreateRecurringInvoice,
  useUpdateRecurringInvoice,
  getListRecurringInvoicesQueryKey,
  type InvoiceLineInput,
  type Party,
  type RecurringInvoiceTemplate,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { RequireClientScope } from "@/components/require-client-scope";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { idMap, scopedToSupplier } from "@/lib/rows";
import { formatNaira, formatDate, pillClasses } from "@/lib/format";
import { Plus, Trash2, Repeat, Pause, Play } from "lucide-react";

// Same standard rate the invoice form uses; the VAT select stores the
// fraction string directly, so the payload conversion stays a straight
// String(Number(...)) like invoice-new's.
const VAT_STANDARD = "0.075";

interface TemplateLine {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

interface TemplateForm {
  name: string;
  buyerPartyId: string;
  cadence: "weekly" | "monthly";
  startDate: string;
  lines: TemplateLine[];
}

const emptyLine = (): TemplateLine => ({
  description: "",
  quantity: "1",
  unitPrice: "",
  vatRate: VAT_STANDARD,
});

const today = () => new Date().toISOString().slice(0, 10);

const emptyForm = (): TemplateForm => ({
  name: "",
  buyerPartyId: "",
  cadence: "monthly",
  startDate: today(),
  lines: [emptyLine()],
});

const cadenceLabel = (cadence: string) =>
  cadence === "weekly" ? "Weekly" : cadence === "monthly" ? "Monthly" : cadence;

// Standing amount per run, derived from the template's own lines.
const templateTotal = (t: RecurringInvoiceTemplate) =>
  t.lines.reduce((sum, l) => {
    const ext = Number(l.quantity) * Number(l.unitPrice);
    return sum + ext + ext * Number(l.vatRate);
  }, 0);

/** "New recurring invoice" dialog: owns its form state and the create
 * mutation; the parent only opens/closes it. Fields reset on close so a
 * cancelled draft never leaks into the next open. */
function NewRecurringDialog({
  open,
  onOpenChange,
  buyers,
  supplierPartyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  buyers: Party[];
  supplierPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const create = useCreateRecurringInvoice();
  const [form, setForm] = useState<TemplateForm>(emptyForm);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) setForm(emptyForm());
    onOpenChange(nextOpen);
  };

  const setLine = (i: number, patch: Partial<TemplateLine>) =>
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    }));

  const totals = form.lines.reduce(
    (acc, l) => {
      const ext = Number(l.quantity || 0) * Number(l.unitPrice || 0);
      acc.net += ext;
      acc.vat += ext * Number(l.vatRate || 0);
      return acc;
    },
    { net: 0, vat: 0 },
  );

  const isValid =
    !!form.name.trim() &&
    !!form.buyerPartyId &&
    !!form.startDate &&
    form.lines.length > 0 &&
    form.lines.every(
      (l) =>
        l.description.trim() &&
        Number(l.quantity) > 0 &&
        l.unitPrice !== "" &&
        Number(l.unitPrice) >= 0,
    );

  const submit = async () => {
    if (!isValid || create.isPending) return;
    try {
      // Same payload conversion as the invoice form: the VAT select already
      // holds the fraction string ("0.075"), normalized via String(Number()).
      const lines: InvoiceLineInput[] = form.lines.map((l) => ({
        description: l.description.trim(),
        quantity: String(Number(l.quantity)),
        unitPrice: String(Number(l.unitPrice)),
        vatRate: String(Number(l.vatRate)),
      }));
      await create.mutateAsync({
        data: {
          supplierPartyId,
          buyerPartyId: form.buyerPartyId,
          name: form.name.trim(),
          cadence: form.cadence,
          startDate: form.startDate,
          currency: "NGN",
          lines,
        },
      });
      // Not awaited: a background refetch rejection must not surface as a
      // false "could not create" error after the save already succeeded.
      queryClient.invalidateQueries({
        queryKey: getListRecurringInvoicesQueryKey(),
      });
      toast({
        title: "Recurring invoice created",
        description: "Drafts will be generated on schedule.",
      });
      handleOpenChange(false);
    } catch (e) {
      toast({
        title: "Could not create recurring invoice",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New recurring invoice</DialogTitle>
          <DialogDescription>
            We turn this template into an ordinary draft invoice on every run —
            you review and submit it like any other.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="recurring-name">Name</Label>
            <Input
              id="recurring-name"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Monthly retainer — Acme"
              maxLength={120}
              data-testid="input-recurring-name"
            />
          </div>
          <div>
            <Label htmlFor="buyer-select">Customer</Label>
            {buyers.length === 0 ? (
              <div
                id="buyer-select"
                className="border rounded-md px-3 py-2 mt-1"
                data-testid="text-no-buyers"
              >
                <span className="text-sm text-muted-foreground">
                  No customers yet — add your first customer from the{" "}
                  <Link
                    href="/invoices/new"
                    className="text-primary hover:underline"
                  >
                    new invoice form
                  </Link>
                  .
                </span>
              </div>
            ) : (
              <Select
                value={form.buyerPartyId || undefined}
                onValueChange={(v) =>
                  setForm((f) => ({ ...f, buyerPartyId: v }))
                }
              >
                <SelectTrigger id="buyer-select">
                  <SelectValue placeholder="Select a customer…" />
                </SelectTrigger>
                <SelectContent>
                  {buyers.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.legalName}
                      {b.tin ? ` — ${b.tin}` : " (no TIN)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label htmlFor="cadence-select">Cadence</Label>
              <Select
                value={form.cadence}
                onValueChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    cadence: v === "weekly" ? "weekly" : "monthly",
                  }))
                }
              >
                <SelectTrigger id="cadence-select" data-testid="select-cadence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="start-date">Start date</Label>
              <Input
                id="start-date"
                type="date"
                value={form.startDate}
                onChange={(e) =>
                  setForm((f) => ({ ...f, startDate: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Line items</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setForm((f) => ({ ...f, lines: [...f.lines, emptyLine()] }))
                }
                data-testid="button-add-line"
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add
              </Button>
            </div>
            {form.lines.map((l, i) => (
              <div key={i} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    <Label htmlFor={`line-${i}-description`} className="sr-only">
                      Line {i + 1} description
                    </Label>
                    <Input
                      id={`line-${i}-description`}
                      placeholder="Description"
                      value={l.description}
                      onChange={(e) =>
                        setLine(i, { description: e.target.value })
                      }
                    />
                  </div>
                  {form.lines.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove line item"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          lines: f.lines.filter((_, idx) => idx !== i),
                        }))
                      }
                    >
                      <Trash2
                        className="w-4 h-4 text-muted-foreground"
                        aria-hidden="true"
                      />
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
                      value={l.quantity}
                      onChange={(e) => setLine(i, { quantity: e.target.value })}
                    />
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
                      value={l.unitPrice}
                      onChange={(e) =>
                        setLine(i, { unitPrice: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor={`line-${i}-vat`} className="text-xs">
                      VAT rate
                    </Label>
                    <Select
                      value={l.vatRate}
                      onValueChange={(v) => setLine(i, { vatRate: v })}
                    >
                      <SelectTrigger id={`line-${i}-vat`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0.075">7.5% standard</SelectItem>
                        <SelectItem value="0">0% exempt</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t pt-3 space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Net per run</span>
              <span className="tabular-nums">{formatNaira(totals.net)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">VAT</span>
              <span className="tabular-nums">{formatNaira(totals.vat)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Total per run</span>
              <span className="tabular-nums">
                {formatNaira(totals.net + totals.vat)}
              </span>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={create.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!isValid || create.isPending}
            data-testid="button-create-recurring"
          >
            {create.isPending ? "Saving…" : "Create recurring invoice"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Recurring() {
  usePageTitle("Recurring invoices");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data: parties } = useListParties();
  const {
    data: templates,
    isLoading,
    isError,
    refetch,
  } = useListRecurringInvoices();
  const update = useUpdateRecurringInvoice();

  const [dialogOpen, setDialogOpen] = useState(false);
  // Only the clicked row's button shows the pending state.
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const buyers = useMemo(
    () =>
      (parties || []).filter(
        (p) => p.type === "buyer" && p.id !== me?.clientPartyId,
      ),
    [parties, me?.clientPartyId],
  );

  const partyName = useMemo(
    () => idMap(parties, (p) => p.id, (p) => p.legalName),
    [parties],
  );

  // The client's own templates, like the invoice vault scopes its rows.
  const rows = useMemo(
    () => scopedToSupplier(templates || [], me?.clientPartyId),
    [templates, me?.clientPartyId],
  );

  const toggleActive = async (t: RecurringInvoiceTemplate) => {
    setTogglingId(t.id);
    try {
      await update.mutateAsync({ id: t.id, data: { active: !t.active } });
      // Not awaited: a background refetch rejection must not surface as a
      // false failure toast after the update already succeeded.
      queryClient.invalidateQueries({
        queryKey: getListRecurringInvoicesQueryKey(),
      });
      toast({
        title: t.active ? "Template paused" : "Template resumed",
        description: t.active
          ? `${t.name} will not generate drafts until resumed.`
          : `${t.name} will generate drafts on schedule again.`,
      });
    } catch (e) {
      toast({
        title: "Could not update template",
        description: serverErrorMessage(e),
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recurring invoices"
        description="Standing templates that turn into draft invoices on schedule."
      >
        {me?.clientPartyId && (
          <Button
            onClick={() => setDialogOpen(true)}
            data-testid="button-new-recurring"
          >
            <Plus className="w-4 h-4 mr-2" aria-hidden="true" />
            New recurring invoice
          </Button>
        )}
      </PageHeader>

      <RequireClientScope thing="recurring invoice list">
        {me?.clientPartyId && (
          <NewRecurringDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            buyers={buyers}
            supplierPartyId={me.clientPartyId}
          />
        )}

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20" />
            ))}
          </div>
        ) : isError ? (
          <QueryError
            thing="your recurring invoices"
            onRetry={() => refetch()}
          />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState
              icon={Repeat}
              title="No recurring invoices yet"
              description="Set up a standing template and we'll draft the invoice for you every week or month."
            >
              <Button
                className="mt-2"
                onClick={() => setDialogOpen(true)}
                data-testid="button-empty-new-recurring"
              >
                Create your first template
              </Button>
            </EmptyState>
          </Card>
        ) : (
          <div className="space-y-3">
            {rows.map((t) => (
              <Card key={t.id} data-testid={`row-template-${t.id}`}>
                <CardContent className="flex flex-wrap items-center justify-between p-4 gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold truncate">{t.name}</span>
                      <span
                        className={pillClasses(t.active ? "emerald" : "slate")}
                      >
                        {t.active ? "Active" : "Paused"}
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 truncate">
                      {partyName.get(t.buyerPartyId) || "Unknown customer"} ·{" "}
                      {cadenceLabel(t.cadence)} · Next run{" "}
                      {formatDate(t.nextRunDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="font-semibold tabular-nums">
                      {formatNaira(templateTotal(t))}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => toggleActive(t)}
                      disabled={update.isPending && togglingId === t.id}
                      data-testid={`button-toggle-${t.id}`}
                    >
                      {t.active ? (
                        <>
                          <Pause className="w-4 h-4 mr-1" aria-hidden="true" />
                          {togglingId === t.id ? "Pausing…" : "Pause"}
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 mr-1" aria-hidden="true" />
                          {togglingId === t.id ? "Resuming…" : "Resume"}
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </RequireClientScope>
    </div>
  );
}
