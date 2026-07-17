import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  useGetMe,
  useListParties,
  useCreateInvoice,
  useDraftInvoiceWithClerk,
  useListErrorCatalogue,
  useListLineItemSuggestions,
  getListInvoicesQueryKey,
  type InvoiceLineInput,
  type LineItemSuggestion,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/page-header";
import { RequireClientScope } from "@/components/require-client-scope";
import { AddCustomerDialog } from "@/components/add-customer-dialog";
import { BuyerSelectOptions } from "@/components/buyer-select-options";
import { FieldError, invalidClass } from "@/components/field-error";
import { LineItemRow } from "@/components/line-item-row";
import { formatNaira } from "@/lib/format";
import { handleClerkGatewayError } from "@/lib/clerk";
import {
  type LineDraft,
  VAT_STANDARD,
  emptyLine,
  lineTotals,
  todayIsoDate,
  toInvoiceLineInputs,
  updateLineAt,
} from "@/lib/invoice-lines";
import {
  Plus,
  CheckCircle2,
  Circle,
  Cloud,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

// Exported for invoice-detail's "New from this invoice", which seeds this
// page's offline draft before navigating here.
export const DRAFT_KEY = "meridianiq:invoice-draft";

export interface DraftState {
  invoiceNumber: string;
  buyerPartyId: string;
  issueDate: string;
  dueDate: string;
  lines: LineDraft[];
}

const emptyDraft = (): DraftState => ({
  invoiceNumber: "",
  buyerPartyId: "",
  issueDate: todayIsoDate(),
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
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);

  // Frequent items (line-item memory): mined server-side from this client's
  // own invoices. Clicking a chip appends a prefilled line — a suggestion the
  // user edits like any other; nothing is created until they save.
  const { data: frequentItems } = useListLineItemSuggestions();
  const addFrequentItem = (item: LineItemSuggestion) => {
    const line = {
      description: item.description,
      quantity: "1",
      unitPrice: item.medianUnitPrice,
      // The form offers the two lawful choices; anything else defaults to
      // standard for the user to see (same rule as the Clerk draft path).
      vatRate: Number(item.vatRate) === 0 ? "0" : VAT_STANDARD,
    };
    setDraft((d) => {
      // Fill the trailing empty line if there is one; append otherwise.
      const last = d.lines[d.lines.length - 1];
      const lastIsEmpty =
        last && !last.description.trim() && !Number(last.unitPrice);
      return {
        ...d,
        lines: lastIsEmpty ? [...d.lines.slice(0, -1), line] : [...d.lines, line],
      };
    });
  };

  const buyers = useMemo(
    () => (parties || []).filter((p) => p.type === "buyer"),
    [parties],
  );

  // "Draft with Clerk" (idea #7): one sentence prefills the SAME form below —
  // Clerk proposes, the client reviews and saves through the ordinary create
  // path; nothing exists until they click "Create invoice".
  const clerkDraft = useDraftInvoiceWithClerk();
  const [clerkText, setClerkText] = useState("");
  const [clerkNote, setClerkNote] = useState<string | null>(null);

  const draftWithClerk = async () => {
    try {
      const res = await clerkDraft.mutateAsync({ data: { text: clerkText } });
      const p = res.proposal;
      // Buyer identity is only ever a suggestion: preselect the top match if
      // it is a customer the picker actually offers; otherwise say what Clerk
      // read so the user can pick or add the customer themselves.
      const top = res.buyerSuggestions[0];
      const matchedBuyerId =
        top && buyers.some((b) => b.id === top.partyId) ? top.partyId : "";
      setDraft((d) => ({
        invoiceNumber: p.invoiceNumber ?? d.invoiceNumber,
        buyerPartyId: matchedBuyerId || d.buyerPartyId,
        issueDate: p.issueDate ?? d.issueDate,
        dueDate: p.dueDate ?? d.dueDate,
        lines:
          p.lines.length > 0
            ? p.lines.map((l) => ({
                description: l.description,
                quantity: l.quantity,
                unitPrice: l.unitPrice ?? "",
                // The form offers the two lawful choices; anything else the
                // instruction implied defaults to standard for the user to see.
                vatRate: l.vatRate === "0" ? "0" : VAT_STANDARD,
              }))
            : d.lines,
      }));
      setClerkNote(
        p.buyerName && !matchedBuyerId
          ? `Clerk read the customer as "${p.buyerName}" — pick or add them below, then check every field.`
          : "Prefilled from your instruction — check every field before saving.",
      );
    } catch (e) {
      handleClerkGatewayError(e, {
        onDisabled: () =>
          setClerkNote(
            "Clerk is currently unavailable — fill the form manually.",
          ),
        toast,
        fallbackTitle: "Clerk couldn't draft that",
      });
    }
  };

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

  const totals = lineTotals(draft.lines);

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

  const setLine = (i: number, patch: Partial<LineDraft>) =>
    setDraft((d) => ({ ...d, lines: updateLineAt(d.lines, i, patch) }));

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
      const lines: InvoiceLineInput[] = toInvoiceLineInputs(draft.lines);
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
      // Not awaited: a background refetch rejection must not surface as a false
      // "could not create invoice" error after the save already succeeded.
      queryClient.invalidateQueries({ queryKey: getListInvoicesQueryKey() });
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
    <div className="space-y-6">
      <PageHeader
        title="New invoice"
        description="We check it against FIRS rules as you type."
      >
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
      </PageHeader>

      <RequireClientScope thing="invoice form">
      <AddCustomerDialog
        open={addCustomerOpen}
        onOpenChange={setAddCustomerOpen}
        onCreated={(party) =>
          setDraft((d) => ({ ...d, buyerPartyId: party.id }))
        }
      />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-violet-200 dark:border-violet-900">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles
                  className="w-4 h-4 text-violet-600 dark:text-violet-400"
                  aria-hidden="true"
                />
                Draft with Clerk
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label htmlFor="clerk-draft-text" className="sr-only">
                Describe the invoice
              </Label>
              <Textarea
                id="clerk-draft-text"
                value={clerkText}
                onChange={(e) => setClerkText(e.target.value)}
                rows={2}
                placeholder='e.g. "Invoice Adaeze Foods ₦150,000 for June deliveries, 7.5% VAT"'
                data-testid="input-clerk-draft"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Clerk prefills the form below — you review and save; nothing
                  is created until you do.
                </p>
                <Button
                  variant="outline"
                  onClick={draftWithClerk}
                  disabled={clerkText.trim().length < 5 || clerkDraft.isPending}
                  data-testid="button-clerk-draft"
                >
                  {clerkDraft.isPending ? "Drafting…" : "Draft it"}
                </Button>
              </div>
              {clerkNote && (
                <p
                  className="text-xs text-violet-800 dark:text-violet-300"
                  data-testid="text-clerk-note"
                >
                  {clerkNote}
                </p>
              )}
            </CardContent>
          </Card>

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
                  <div
                    id="buyer-select"
                    className="border rounded-md px-3 py-2 mt-1 flex flex-wrap items-center justify-between gap-2"
                    data-testid="text-no-buyers"
                  >
                    <span className="text-sm text-muted-foreground">
                      No customers yet — add your first customer.
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAddCustomerOpen(true)}
                      data-testid="button-add-first-customer"
                    >
                      <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add customer
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
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
                          <BuyerSelectOptions buyers={buyers} />
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0"
                      onClick={() => setAddCustomerOpen(true)}
                      data-testid="button-add-customer"
                    >
                      <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add customer
                    </Button>
                  </div>
                )}
                {showErrors && errors.buyerPartyId && (
                  <FieldError id="buyer-select-error">{errors.buyerPartyId}</FieldError>
                )}
                {selectedBuyer && !selectedBuyer.tin && (
                  <p
                    id="buyer-tin-note"
                    role={showErrors ? "alert" : undefined}
                    className={`text-sm mt-1 ${
                      showErrors ? "text-destructive" : "text-amber-700 dark:text-amber-400"
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
              {(frequentItems ?? []).length > 0 && (
                <div className="space-y-1.5" data-testid="frequent-items">
                  <p className="text-xs text-muted-foreground">
                    Frequent items — from your own invoices; click to add a
                    prefilled line, then check the price.
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
                    setDraft((d) => ({ ...d, lines: d.lines.filter((_, idx) => idx !== i) }))
                  }
                  errors={{
                    description: showErrors ? errors[`line-${i}-desc`] : undefined,
                    quantity: showErrors ? errors[`line-${i}-qty`] : undefined,
                    unitPrice: showErrors ? errors[`line-${i}-price`] : undefined,
                  }}
                  showTotal
                />
              ))}
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
                  <span className={c.ok ? "" : "text-muted-foreground"}>
                    {c.label}
                    <span className="sr-only">{c.ok ? " — complete" : " — not yet"}</span>
                  </span>
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
      </RequireClientScope>
    </div>
  );
}
