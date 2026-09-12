import { type ReactNode } from "react";
import {
  useDecideClerkCase,
  type ClerkCaseDecisionInputCategory,
  type ClerkPartySuggestions,
  type Firm,
  type InvoiceLineInput,
  type Party,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PartySuggestionChips } from "@/pages/clerk-party-suggestions";
import {
  type ApproveForm,
  approveDecisionFromForm,
} from "@/pages/clerk-shared";
import { CATEGORIES } from "./constants";
import { FirmSelect, PartySelect } from "./selects";
import { InvoiceApprovalSummary } from "./approval-summary";

export function InvoiceDecisionForm({
  form,
  setForm,
  reason,
  setReason,
  firms,
  parties,
  partySuggestions,
  claimControls,
  caseId,
  decideCase,
  approveDisabled,
  linesPreflightHit,
}: {
  form: ApproveForm;
  setForm: (form: ApproveForm) => void;
  reason: string;
  setReason: (reason: string) => void;
  firms: Firm[] | undefined;
  parties: Party[] | undefined;
  partySuggestions: ClerkPartySuggestions | undefined;
  claimControls: ReactNode;
  caseId: string;
  decideCase: ReturnType<typeof useDecideClerkCase>;
  approveDisabled: boolean;
  linesPreflightHit: boolean;
}) {
  const setLine = (i: number, patch: Partial<InvoiceLineInput>) => {
    setForm({
      ...form,
      lines: form.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)),
    });
  };

  return (
    <div className="border-t pt-4 space-y-3">
      <p className="text-sm font-medium">
        Review and approve — creates a draft invoice only
      </p>
      {claimControls}
      <div className="clerk-review-fields">
        <FirmSelect
          firms={firms}
          value={form.firmId}
          onChange={(v) => setForm({ ...form, firmId: v })}
          testId="select-firm"
        />
        <PartySelect
          label="Supplier"
          placeholder="Choose supplier"
          parties={parties}
          value={form.supplierPartyId}
          onChange={(v) => setForm({ ...form, supplierPartyId: v })}
          testId="select-supplier"
        >
          <PartySuggestionChips
            suggestions={partySuggestions?.supplier ?? []}
            value={form.supplierPartyId}
            onPick={(partyId) => setForm({ ...form, supplierPartyId: partyId })}
            testId="suggestions-supplier"
          />
        </PartySelect>
        <PartySelect
          label="Customer"
          placeholder="Choose customer"
          parties={parties}
          value={form.buyerPartyId}
          onChange={(v) => setForm({ ...form, buyerPartyId: v })}
          testId="select-buyer"
        >
          <PartySuggestionChips
            suggestions={partySuggestions?.buyer ?? []}
            value={form.buyerPartyId}
            onPick={(partyId) => setForm({ ...form, buyerPartyId: partyId })}
            testId="suggestions-buyer"
          />
        </PartySelect>
      </div>
      <div className="clerk-review-fields">
        <div className="space-y-1">
          <Label htmlFor="apr-number">Invoice number</Label>
          <Input
            id="apr-number"
            value={form.invoiceNumber}
            onChange={(e) =>
              setForm({
                ...form,
                invoiceNumber: e.target.value,
              })
            }
            data-testid="input-approve-number"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apr-issue">Issue date</Label>
          <Input
            id="apr-issue"
            type="date"
            value={form.issueDate}
            onChange={(e) => setForm({ ...form, issueDate: e.target.value })}
            data-testid="input-approve-issue-date"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apr-due">Due date</Label>
          <Input
            id="apr-due"
            type="date"
            value={form.dueDate}
            onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            data-testid="input-approve-due-date"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apr-currency">Currency</Label>
          <Input
            id="apr-currency"
            value={form.currency}
            onChange={(event) =>
              setForm({ ...form, currency: event.target.value })
            }
            data-testid="input-approve-currency"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="apr-category">Category</Label>
          <Select
            value={form.category}
            onValueChange={(v) =>
              setForm({
                ...form,
                category: v as ClerkCaseDecisionInputCategory,
              })
            }
          >
            <SelectTrigger id="apr-category" data-testid="select-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div
        id="apr-lines"
        tabIndex={-1}
        role="group"
        aria-label="Invoice items"
        className={`space-y-3 focus:outline-none focus:ring-2 focus:ring-ring${
          linesPreflightHit
            ? " rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800 dark:bg-amber-950/20"
            : ""
        }`}
      >
        <Label>Invoice items</Label>
        {form.lines.map((line, i) => (
          <div
            key={i}
            className="grid grid-cols-2 gap-2 border-b pb-3"
            data-testid={`row-line-${i}`}
          >
            <p className="col-span-2 text-xs font-medium text-muted-foreground">
              Item {i + 1}
            </p>
            <div className="col-span-2 space-y-1">
              <Label htmlFor={`apr-line-${i}-description`}>Description</Label>
              <Input
                id={`apr-line-${i}-description`}
                aria-label={`Line ${i + 1} description`}
                placeholder="Description"
                value={line.description}
                onChange={(e) => setLine(i, { description: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`apr-line-${i}-quantity`}>Quantity</Label>
              <Input
                id={`apr-line-${i}-quantity`}
                aria-label={`Line ${i + 1} quantity`}
                placeholder="Qty"
                value={line.quantity}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`apr-line-${i}-unitPrice`}>Unit price</Label>
              <Input
                id={`apr-line-${i}-unitPrice`}
                aria-label={`Line ${i + 1} unit price`}
                placeholder="Unit price"
                value={line.unitPrice}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`apr-line-${i}-vatRate`}>VAT %</Label>
              <Input
                id={`apr-line-${i}-vatRate`}
                aria-label={`Line ${i + 1} VAT rate`}
                placeholder="VAT %"
                value={line.vatRate}
                onChange={(e) => setLine(i, { vatRate: e.target.value })}
              />
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <Label htmlFor="apr-reason">
          Reason (required to reject or escalate)
        </Label>
        <Textarea
          id="apr-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          data-testid="input-decision-reason"
        />
      </div>
      <InvoiceApprovalSummary form={form} firms={firms} parties={parties} />
      <div className="flex gap-2 flex-wrap">
        <Button
          type="button"
          className="h-auto min-h-11 whitespace-normal"
          aria-describedby="invoice-approval-summary"
          onClick={() =>
            decideCase.mutate({
              id: caseId,
              // The shared builder — the fast-lane bulk
              // items are built by this same function.
              data: approveDecisionFromForm(form, reason),
            })
          }
          disabled={approveDisabled || decideCase.isPending}
          data-testid="button-approve-case"
        >
          Approve as draft invoice
        </Button>
        <Button
          variant="destructive"
          onClick={() =>
            decideCase.mutate({
              id: caseId,
              data: { action: "reject", reason },
            })
          }
          disabled={!reason.trim() || decideCase.isPending}
          data-testid="button-reject-case"
        >
          Reject
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            decideCase.mutate({
              id: caseId,
              data: { action: "escalate", reason },
            })
          }
          disabled={!reason.trim() || decideCase.isPending}
          data-testid="button-escalate-case"
        >
          Escalate
        </Button>
      </div>
    </div>
  );
}

// ---- The notice decision form -----------------------------------------------
// The invoice form's twin for notice cases. Approval records a response
// OBLIGATION (client, authority, deadline), never an invoice; the selects
// are bound to the contract's closed catalogues; reject/escalate take an
// optional reason. Kept as its own component — see InvoiceDecisionForm's
// note on why the twins are never merged.
