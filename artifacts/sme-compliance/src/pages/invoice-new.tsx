import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  useListParties,
  useCreateInvoice,
  type InvoiceLineInput,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
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

function loadDraft(): DraftState {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as DraftState;
  } catch {
    /* ignore corrupt draft */
  }
  return {
    invoiceNumber: "",
    buyerPartyId: "",
    issueDate: today(),
    dueDate: "",
    lines: [emptyLine()],
  };
}

export function InvoiceNew() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const { data: parties } = useListParties();
  const create = useCreateInvoice();

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
  if (!draft.issueDate) errors.issueDate = "Issue date is required.";
  draft.lines.forEach((l, i) => {
    if (!l.description.trim()) errors[`line-${i}-desc`] = "Description required.";
    if (!(Number(l.quantity) > 0)) errors[`line-${i}-qty`] = "Qty must be > 0.";
    if (!(Number(l.unitPrice) >= 0) || l.unitPrice === "")
      errors[`line-${i}-price`] = "Price required.";
  });
  const isValid = Object.keys(errors).length === 0;

  const setLine = (i: number, patch: Partial<DraftLine>) =>
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
    }));

  const submit = async () => {
    setShowErrors(true);
    if (!isValid || !me?.clientPartyId) return;
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

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">New Invoice</h1>
          <p className="text-muted-foreground">
            We check it against FIRS rules as you type.
          </p>
        </div>
        {savedAt && (
          <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
            <Cloud className="w-3.5 h-3.5" /> Draft saved offline
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
                <Label>Invoice number</Label>
                <Input
                  value={draft.invoiceNumber}
                  onChange={(e) => setDraft((d) => ({ ...d, invoiceNumber: e.target.value }))}
                  placeholder="INV-1006"
                />
                {showErrors && errors.invoiceNumber && (
                  <p className="text-xs text-destructive mt-1">{errors.invoiceNumber}</p>
                )}
              </div>
              <div>
                <Label>Customer</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm"
                  value={draft.buyerPartyId}
                  onChange={(e) => setDraft((d) => ({ ...d, buyerPartyId: e.target.value }))}
                >
                  <option value="">Select a customer…</option>
                  {buyers.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.legalName}
                      {b.tin ? ` — ${b.tin}` : " (no TIN)"}
                    </option>
                  ))}
                </select>
                {showErrors && errors.buyerPartyId && (
                  <p className="text-xs text-destructive mt-1">{errors.buyerPartyId}</p>
                )}
                {selectedBuyer && !selectedBuyer.tin && (
                  <p className="text-xs text-amber-600 mt-1">
                    This customer has no TIN on file — FIRS requires a buyer TIN for B2B invoices.
                  </p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Issue date</Label>
                  <Input
                    type="date"
                    value={draft.issueDate}
                    onChange={(e) => setDraft((d) => ({ ...d, issueDate: e.target.value }))}
                  />
                </div>
                <div>
                  <Label>Due date (optional)</Label>
                  <Input
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
                <Plus className="w-4 h-4 mr-1" /> Add
              </Button>
            </CardHeader>
            <CardContent className="space-y-4">
              {draft.lines.map((l, i) => (
                <div key={i} className="rounded-lg border p-3 space-y-3">
                  <div className="flex items-start gap-2">
                    <Input
                      className="flex-1"
                      placeholder="Description"
                      value={l.description}
                      onChange={(e) => setLine(i, { description: e.target.value })}
                    />
                    {draft.lines.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() =>
                          setDraft((d) => ({ ...d, lines: d.lines.filter((_, idx) => idx !== i) }))
                        }
                      >
                        <Trash2 className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    )}
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-xs">Qty</Label>
                      <Input
                        type="number"
                        value={l.quantity}
                        onChange={(e) => setLine(i, { quantity: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Unit price</Label>
                      <Input
                        type="number"
                        value={l.unitPrice}
                        onChange={(e) => setLine(i, { unitPrice: e.target.value })}
                      />
                    </div>
                    <div>
                      <Label className="text-xs">VAT rate</Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm shadow-sm"
                        value={l.vatRate}
                        onChange={(e) => setLine(i, { vatRate: e.target.value })}
                      >
                        <option value="0.075">7.5% standard</option>
                        <option value="0">0% exempt</option>
                      </select>
                    </div>
                  </div>
                  <div className="text-right text-sm text-muted-foreground">
                    Line total {formatNaira(lineTotal(l).total)}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="lg:sticky lg:top-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="w-4 h-4 text-primary" /> Compliance check
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {checklist.map((c, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  {c.ok ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                  ) : (
                    <Circle className="w-4 h-4 text-muted-foreground shrink-0" />
                  )}
                  <span className={c.ok ? "" : "text-muted-foreground"}>{c.label}</span>
                </div>
              ))}
              <div className="border-t pt-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Net</span>
                  <span>{formatNaira(totals.net)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">VAT</span>
                  <span>{formatNaira(totals.vat)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span>{formatNaira(totals.net + totals.vat)}</span>
                </div>
              </div>
              <Button className="w-full" onClick={submit} disabled={create.isPending}>
                {create.isPending ? "Saving…" : "Create invoice"}
              </Button>
              {showErrors && !isValid && (
                <p className="text-xs text-destructive text-center">
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
