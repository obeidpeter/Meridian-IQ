import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  useListParties,
  useCreateInvoice,
  useListErrorCatalogue,
  type InvoiceLineInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { formatNaira } from "@/lib/format";
import { Plus, Trash2, CheckCircle2, Circle, Cloud, ShieldCheck } from "lucide-react";

const DRAFT_KEY = "meridianiq:invoice-draft";
const VAT_STANDARD = "0.075";

interface DraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  vatRate: string;
}

interface DraftState {
  invoiceNumber: string;
  buyerPartyId: string;
  issueDate: string;
  dueDate: string;
  lines: DraftLine[];
}

const emptyLine = (): DraftLine => ({
  description: "",
  quantity: "1",
  unitPrice: "",
  vatRate: VAT_STANDARD,
});

const today = () => new Date().toISOString().slice(0, 10);

const emptyDraft = (): DraftState => ({
  invoiceNumber: "",
  buyerPartyId: "",
  issueDate: today(),
  dueDate: "",
  lines: [emptyLine()],
});

function loadDraft(): DraftState {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as DraftState;
  } catch {
    /* ignore corrupt draft */
  }
  return emptyDraft();
}

/** Inline field error (§7): red text tied to its input via aria-describedby. */
function FieldError({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} role="alert" className="text-sm text-destructive mt-1">
      {children}
    </p>
  );
}

export function InvoiceNew() {
  usePageTitle("New invoice");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data: parties } = useListParties();
  const { data: catalogue } = useListErrorCatalogue();
  const create = useCreateInvoice();

  const tinGuidance = useMemo(() => {
    const entry = (catalogue || []).find((c) => c.code === "MBS_INVALID_TIN");
    return (
      entry?.fix ??
      "Add the customer's Tax Identification Number before submitting — the NRS rejects B2B invoices without a valid buyer TIN."
    );
  }, [catalogue]);

  const [draft, setDraft] = useState<DraftState>(loadDraft);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const buyers = useMemo(
    () => (parties || []).filter((p) => p.type === "buyer"),
    [parties],
  );

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
      setSavedAt(new Date());
    }, 400);
    return () => clearTimeout(t);
  }, [draft]);

  const discardDraft = () => {
    localStorage.removeItem(DRAFT_KEY);
    setDraft(emptyDraft());
    setSavedAt(null);
    setShowErrors(false);
  };

  const selectedBuyer = buyers.find((b) => b.id === draft.buyerPartyId);

  const lineTotal = (l: DraftLine) => {
    const ext = Number(l.quantity || 0) * Number(l.unitPrice || 0);
    const vat = ext * Number(l.vatRate || 0);
    return { ext, vat, total: ext + vat };
  };
  const totals = draft.lines.reduce(
    (acc, l) => {
      const { ext, vat } = lineTotal(l);
      acc.net += ext;
      acc.vat += vat;
      return acc;
    },
    { net: 0, vat: 0 },
  );

  const errors: Record<string, string> = {};
  if (!draft.invoiceNumber.trim()) errors.invoiceNumber = "Invoice number is required.";
  if (!draft.buyerPartyId) errors.buyerPartyId = "Select a customer.";
  else if (!selectedBuyer?.tin) errors.buyerTin = tinGuidance;
  if (!draft.issueDate) errors.issueDate = "Issue date is required.";
  draft.lines.forEach((l, i) => {
    if (!l.description.trim()) errors[`line-${i}-desc`] = "Description required.";
    if (!(Number(l.quantity) > 0)) errors[`line-${i}-qty`] = "Qty must be > 0.";
    if (!(Number(l.unitPrice) >= 0) || l.unitPrice === "")
      errors[`line-${i}-price`] = "Price required.";
  });
  const isValid = Object.keys(errors).length === 0;

  // Which DOM element carries each validation error, in visual order — used to
  // scroll/focus the first invalid field on a failed submit.
  const errorFieldIds = (): string[] => {
    const ids: string[] = [];
    if (errors.invoiceNumber) ids.push("invoice-number");
    if (errors.buyerPartyId || errors.buyerTin) ids.push("buyer-select");
    if (errors.issueDate) ids.push("issue-date");
    draft.lines.forEach((_, i) => {
      if (errors[`line-${i}-desc`]) ids.push(`line-${i}-description`);
      if (errors[`line-${i}-qty`]) ids.push(`line-${i}-quantity`);
      if (errors[`line-${i}-price`]) ids.push(`line-${i}-unit-price`);
    });
    return ids;
  };

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    }));

  const submit = async () => {
    setShowErrors(true);
    if (!isValid) {
      const first = errorFieldIds()[0];
      if (first) {
        const el = document.getElementById(first);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement | null)?.focus({ preventScroll: true });
      }
      return;
    }
    if (!me?.clientPartyId) return;
    try {
      const lines: InvoiceLineInput[] = draft.lines.map((l) => ({
        description: l.description.trim(),
        quantity: String(Number(l.quantity)),
        unitPrice: String(Number(l.unitPrice)),
        vatRate: String(Number(l.vatRate)),
      }));
      const res = await create.mutateAsync({
        data: {
          supplierPartyId: me.clientPartyId,
          buyerPartyId: draft.buyerPartyId,
          invoiceNumber: draft.invoiceNumber.trim(),
          currency: "NGN",
          issueDate: draft.issueDate,
          dueDate: draft.dueDate || undefined,
          lines,
        },
      });
      localStorage.removeItem(DRAFT_KEY);
      await queryClient.invalidateQueries();
      toast({ title: "Invoice created", description: "Saved to your vault." });
      navigate(`/invoices/${res.invoice.id}`);
    } catch (e) {
      toast({
        title: "Could not create invoice",
        description: e instanceof Error ? e.message : "Please check the fields and try again.",
        variant: "destructive",
      });
    }
  };

  const checklist = [
    { ok: !!draft.invoiceNumber.trim(), label: "Invoice number" },
    { ok: !!draft.buyerPartyId, label: "Customer selected" },
    { ok: !!selectedBuyer?.tin, label: "Customer has a TIN" },
    { ok: draft.lines.every((l) => l.description.trim() && Number(l.quantity) > 0), label: "Line items complete" },
    { ok: draft.lines.every((l) => Number(l.vatRate) === 0.075 || Number(l.vatRate) === 0), label: "VAT at 7.5% (or exempt)" },
  ];

  const invalidClass = (bad: boolean) =>
    bad ? "border-destructive focus-visible:ring-destructive" : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            New invoice
          </h1>
          <p className="text-muted-foreground mt-1">
            We check it against FIRS rules as you type.
          </p>
        </div>
        {savedAt && (
          <span className="text-xs text-muted-foreground flex items-center gap-2 shrink-0">
            <span className="flex items-center gap-1">
              <Cloud className="w-3.5 h-3.5" aria-hidden="true" /> Draft saved offline
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={discardDraft}
              data-testid="button-discard-draft"
            >
              Discard draft
            </Button>
          </span>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="invoice-number">Invoice number</Label>
                <Input
                  id="invoice-number"
                  value={draft.invoiceNumber}
                  onChange={(e) => setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))}
                  placeholder="INV-1006"
                  aria-invalid={showErrors && !!errors.invoiceNumber}
                  aria-describedby={
                    showErrors && errors.invoiceNumber ? "invoice-number-error" : undefined
                  }
                  className={invalidClass(showErrors && !!errors.invoiceNumber)}
                />
                {showErrors && errors.invoiceNumber && (
                  <FieldError id="invoice-number-error">{errors.invoiceNumber}</FieldError>
                )}
              </div>
              <div>
                <Label htmlFor="buyer-select">Customer</Label>
                {buyers.length === 0 ? (
                  <p
                    id="buyer-select"
                    className="text-sm text-muted-foreground border rounded-md px-3 py-2 mt-1"
                    data-testid="text-no-buyers"
                  >
                    No customers yet — ask your firm to add your buyers, then they
                    appear here to pick from.
                  </p>
                ) : (
                  <Select
                    value={draft.buyerPartyId || undefined}
                    onValueChange={(v) => setDraft((d) => ({ ...d, buyerPartyId: v }))}
                  >
                    <SelectTrigger
                      id="buyer-select"
                      aria-invalid={showErrors && !!(errors.buyerPartyId || errors.buyerTin)}
                      aria-describedby={
                        showErrors && errors.buyerPartyId
                          ? "buyer-select-error"
                          : errors.buyerTin
                            ? "buyer-tin-note"
                            : undefined
                      }
                      className={invalidClass(
                        showErrors && !!(errors.buyerPartyId || errors.buyerTin),
                      )}
                    >
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
                {showErrors && errors.buyerPartyId && (
                  <FieldError id="buyer-select-error">{errors.buyerPartyId}</FieldError>
                )}
                {selectedBuyer && !selectedBuyer.tin && (
                  <p
                    id="buyer-tin-note"
                    role={showErrors ? "alert" : undefined}
                    className={`text-sm mt-1 ${
                      showErrors ? "text-destructive" : "text-amber-600 dark:text-amber-400"
                    }`}
                  >
                    {errors.buyerTin}
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="issue-date">Issue date</Label>
                  <Input
                    id="issue-date"
                    type="date"
                    value={draft.issueDate}
                    onChange={(e) => setDraft((d) => ({ ...d, issueDate: e.target.value }))}
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
                    onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <CardTitle>Line items</CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft((d) => ({ ...d, lines: [...d.lines, emptyLine()] }))}
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.lines.map((l, i) => {
                const descBad = showErrors && !!errors[`line-${i}-desc`];
                const qtyBad = showErrors && !!errors[`line-${i}-qty`];
                const priceBad = showErrors && !!errors[`line-${i}-price`];
                return (
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
                          onChange={(e) => setLine(i, { description: e.target.value })}
                          aria-invalid={descBad}
                          aria-describedby={descBad ? `line-${i}-description-error` : undefined}
                          className={invalidClass(descBad)}
                        />
                        {descBad && (
                          <FieldError id={`line-${i}-description-error`}>
                            {errors[`line-${i}-desc`]}
                          </FieldError>
                        )}
                      </div>
                      {draft.lines.length > 1 && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Remove line item"
                          onClick={() =>
                            setDraft((d) => ({ ...d, lines: d.lines.filter((_, idx) => idx !== i) }))
                          }
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
                          value={l.quantity}
                          onChange={(e) => setLine(i, { quantity: e.target.value })}
                          aria-invalid={qtyBad}
                          aria-describedby={qtyBad ? `line-${i}-quantity-error` : undefined}
                          className={invalidClass(qtyBad)}
                        />
                        {qtyBad && (
                          <FieldError id={`line-${i}-quantity-error`}>
                            {errors[`line-${i}-qty`]}
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
                          value={l.unitPrice}
                          onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                          aria-invalid={priceBad}
                          aria-describedby={priceBad ? `line-${i}-unit-price-error` : undefined}
                          className={invalidClass(priceBad)}
                        />
                        {priceBad && (
                          <FieldError id={`line-${i}-unit-price-error`}>
                            {errors[`line-${i}-price`]}
                          </FieldError>
                        )}
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
                    <div className="text-right text-sm text-muted-foreground tabular-nums">
                      Line total {formatNaira(lineTotal(l).total)}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="w-4 h-4 text-primary" aria-hidden="true" /> Compliance check
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {checklist.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {c.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" aria-hidden="true" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />
                  )}
                  <span className={c.ok ? "" : "text-muted-foreground"}>{c.label}</span>
                </div>
              ))}
              <div className="border-t pt-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net</span>
                  <span className="tabular-nums">{formatNaira(totals.net)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">VAT</span>
                  <span className="tabular-nums">{formatNaira(totals.vat)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatNaira(totals.net + totals.vat)}</span>
                </div>
              </div>
              <Button className="w-full" onClick={submit} disabled={create.isPending}>
                {create.isPending ? "Saving…" : "Create invoice"}
              </Button>
              {showErrors && !isValid && (
                <p className="text-sm text-destructive text-center" role="alert">
                  Fix the highlighted fields to continue.
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
