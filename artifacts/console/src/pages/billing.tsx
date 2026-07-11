import { useState } from "react";
import {
  useListTiers,
  useGetSubscription,
  useUpdateTier,
  useUpdateSubscription,
  useListPriceReviews,
  getListTiersQueryKey,
  getGetSubscriptionQueryKey,
  getListPriceReviewsQueryKey,
} from "@workspace/api-client-react";
import type { BillingTier } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { Check, History, Pencil } from "lucide-react";
import { formatNaira, formatDate, humanize } from "@/lib/format";

function pct(v: string) {
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function PriceReviewHistory({ tierId }: { tierId: string }) {
  const { data, isLoading, isError, refetch } = useListPriceReviews(tierId);
  if (isLoading) return <Skeleton className="h-24" />;
  if (isError)
    return (
      <QueryError thing="the price review history" onRetry={() => refetch()} />
    );
  if (!data || data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No price reviews recorded for this tier.
      </p>
    );
  return (
    <div className="space-y-2">
      {data.map((r) => (
        <div
          key={r.id}
          data-testid={`row-review-${r.id}`}
          className="text-sm border rounded-md p-2.5"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">{humanize(r.field)}</span>
            <span className="text-xs text-muted-foreground">
              {formatDate(r.effectiveDate)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {r.oldValue ?? "—"} → <span className="font-medium">{r.newValue}</span>
            {r.note ? ` · ${r.note}` : ""}
          </p>
        </div>
      ))}
    </div>
  );
}

interface TierForm {
  monthlyPrice: string;
  includedInvoices: string;
  overagePrice: string;
  revenueSharePct: string;
  effectiveDate: string;
  note: string;
}

// Field-level validation for the price-review dialog (§7: inline, at the
// field, never toast-only).
function validateForm(form: TierForm): Partial<Record<keyof TierForm, string>> {
  const errors: Partial<Record<keyof TierForm, string>> = {};
  if (form.monthlyPrice.trim() === "" || Number(form.monthlyPrice) < 0 || Number.isNaN(Number(form.monthlyPrice)))
    errors.monthlyPrice = "Enter a price of ₦0 or more.";
  const included = Number(form.includedInvoices);
  if (form.includedInvoices.trim() === "" || !Number.isInteger(included) || included < 0)
    errors.includedInvoices = "Enter a whole number of invoices.";
  if (form.overagePrice.trim() === "" || Number(form.overagePrice) < 0 || Number.isNaN(Number(form.overagePrice)))
    errors.overagePrice = "Enter a price of ₦0 or more.";
  const share = Number(form.revenueSharePct);
  if (form.revenueSharePct.trim() === "" || Number.isNaN(share) || share < 0 || share > 100)
    errors.revenueSharePct = "Enter a percentage between 0 and 100.";
  if (!form.effectiveDate) errors.effectiveDate = "Pick the effective date.";
  return errors;
}

export function Billing() {
  usePageTitle("Plans & billing");
  const {
    data: tiers,
    isLoading: tiersLoading,
    error: tiersError,
    refetch: refetchTiers,
  } = useListTiers();
  const {
    data: subscription,
    isLoading: subLoading,
    error: subError,
    refetch: refetchSub,
  } = useGetSubscription();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateTier = useUpdateTier();
  const updateSubscription = useUpdateSubscription();

  const [editTier, setEditTier] = useState<BillingTier | null>(null);
  const [historyTierId, setHistoryTierId] = useState<string | null>(null);
  // Plan switches change what the firm is billed — confirm first (§7).
  const [pendingPlan, setPendingPlan] = useState<BillingTier | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [form, setForm] = useState<TierForm>({
    monthlyPrice: "",
    includedInvoices: "",
    overagePrice: "",
    revenueSharePct: "",
    effectiveDate: "",
    note: "",
  });

  const formErrors = validateForm(form);
  const formValid = Object.keys(formErrors).length === 0;

  const openEdit = (t: BillingTier) => {
    setEditTier(t);
    setShowErrors(false);
    setForm({
      monthlyPrice: t.monthlyPrice,
      includedInvoices: String(t.includedInvoices),
      overagePrice: t.overagePrice,
      revenueSharePct: (Number(t.revenueSharePct) * 100).toString(),
      effectiveDate: new Date().toISOString().slice(0, 10),
      note: "",
    });
  };

  const saveTier = () => {
    if (!editTier) return;
    if (!formValid) {
      setShowErrors(true);
      const firstInvalid = Object.keys(formErrors)[0];
      document.getElementById(`tier-${firstInvalid}`)?.focus();
      return;
    }
    updateTier.mutate(
      {
        id: editTier.id,
        data: {
          monthlyPrice: form.monthlyPrice,
          includedInvoices: Number(form.includedInvoices),
          overagePrice: form.overagePrice,
          revenueSharePct: (Number(form.revenueSharePct) / 100).toString(),
          effectiveDate: form.effectiveDate,
          note: form.note || undefined,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Tier updated", description: "Price review recorded." });
          queryClient.invalidateQueries({ queryKey: getListTiersQueryKey() });
          queryClient.invalidateQueries({
            queryKey: getGetSubscriptionQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getListPriceReviewsQueryKey(editTier.id),
          });
          setEditTier(null);
        },
        onError: () =>
          toast({ title: "Update failed", variant: "destructive" }),
      },
    );
  };

  const selectPlan = (t: BillingTier) => {
    updateSubscription.mutate(
      { data: { tierKey: t.key } },
      {
        onSuccess: () => {
          toast({ title: `Switched to ${t.name}` });
          queryClient.invalidateQueries({
            queryKey: getGetSubscriptionQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Could not switch plan", variant: "destructive" }),
        onSettled: () => setPendingPlan(null),
      },
    );
  };

  const activeKey = subscription?.tier.key;

  const fieldError = (key: keyof TierForm) =>
    showErrors && formErrors[key] ? (
      <p
        id={`tier-${key}-error`}
        role="alert"
        className="text-sm text-destructive mt-1"
      >
        {formErrors[key]}
      </p>
    ) : null;
  const fieldAria = (key: keyof TierForm) => ({
    "aria-invalid": showErrors && !!formErrors[key],
    "aria-describedby":
      showErrors && formErrors[key] ? `tier-${key}-error` : undefined,
    className: showErrors && formErrors[key] ? "border-destructive" : undefined,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Plans & billing
        </h1>
        <p className="text-muted-foreground mt-1">
          Four configurable tiers with revenue share and invoice-volume
          overages. Price changes are recorded as audited semi-annual reviews.
        </p>
      </div>

      {subLoading ? (
        <Skeleton className="h-20" />
      ) : subError ? (
        <QueryError thing="your subscription" onRetry={() => refetchSub()} />
      ) : subscription ? (
        <Card className="bg-accent/40" data-testid="card-current-plan">
          <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="text-xl font-bold">{subscription.tier.name}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold tabular-nums">
                {formatNaira(subscription.tier.monthlyPrice)}/mo
              </p>
              <p className="text-xs text-muted-foreground">
                {subscription.tier.includedInvoices} invoices included ·{" "}
                {pct(subscription.tier.revenueSharePct)} revenue share ·{" "}
                {humanize(subscription.status)}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {tiersLoading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-80" />
          ))}
        </div>
      ) : tiersError ? (
        <QueryError thing="billing tiers" onRetry={() => refetchTiers()} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {(tiers ?? [])
            .filter((t) => t.active)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((t) => {
              const isCurrent = t.key === activeKey;
              return (
                <Card
                  key={t.id}
                  data-testid={`card-tier-${t.key}`}
                  className={isCurrent ? "border-primary ring-1 ring-primary" : ""}
                >
                  <CardHeader className="pb-3">
                    <CardTitle className="flex items-center justify-between text-base">
                      {t.name}
                      {isCurrent && (
                        <span className="text-xs bg-primary text-primary-foreground px-2 py-0.5 rounded-full">
                          Current
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-2xl font-bold tabular-nums">
                      {formatNaira(t.monthlyPrice)}
                      <span className="text-sm font-normal text-muted-foreground">
                        /mo
                      </span>
                    </p>
                    <ul className="text-sm space-y-1.5 text-muted-foreground">
                      <li>{t.includedInvoices} invoices / month</li>
                      <li>{formatNaira(t.overagePrice)} per extra invoice</li>
                      <li>{pct(t.revenueSharePct)} revenue share</li>
                      {t.operatorManaged && <li>Operator-managed support</li>}
                    </ul>
                    <div className="flex gap-2 pt-2">
                      <Button
                        size="sm"
                        variant={isCurrent ? "secondary" : "default"}
                        className="flex-1"
                        disabled={isCurrent}
                        onClick={() => setPendingPlan(t)}
                        data-testid={`button-select-${t.key}`}
                      >
                        {isCurrent ? (
                          <>
                            <Check className="w-4 h-4 mr-1" aria-hidden="true" />{" "}
                            Selected
                          </>
                        ) : (
                          "Select"
                        )}
                      </Button>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openEdit(t)}
                            aria-label={`Edit ${t.name} pricing`}
                            data-testid={`button-edit-${t.key}`}
                          >
                            <Pencil className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit pricing</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setHistoryTierId(t.id)}
                            aria-label={`Price review history for ${t.name}`}
                            data-testid={`button-history-${t.key}`}
                          >
                            <History className="w-4 h-4" aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Price review history</TooltipContent>
                      </Tooltip>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      <AlertDialog
        open={pendingPlan !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPlan(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch your firm to {pendingPlan?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingPlan
                ? `Billing changes to ${formatNaira(pendingPlan.monthlyPrice)}/mo with ${pendingPlan.includedInvoices} invoices included and ${pct(pendingPlan.revenueSharePct)} revenue share.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={updateSubscription.isPending}
              onClick={() => pendingPlan && selectPlan(pendingPlan)}
              data-testid="button-confirm-plan"
            >
              {updateSubscription.isPending ? "Switching…" : "Switch plan"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={!!editTier} onOpenChange={(o) => !o && setEditTier(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Price review — {editTier?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="tier-monthlyPrice">Monthly price (₦)</Label>
                <Input
                  id="tier-monthlyPrice"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.monthlyPrice}
                  onChange={(e) =>
                    setForm({ ...form, monthlyPrice: e.target.value })
                  }
                  {...fieldAria("monthlyPrice")}
                  data-testid="input-monthly-price"
                />
                {fieldError("monthlyPrice")}
              </div>
              <div>
                <Label htmlFor="tier-includedInvoices">Included invoices</Label>
                <Input
                  id="tier-includedInvoices"
                  type="number"
                  min={0}
                  step={1}
                  value={form.includedInvoices}
                  onChange={(e) =>
                    setForm({ ...form, includedInvoices: e.target.value })
                  }
                  {...fieldAria("includedInvoices")}
                  data-testid="input-included-invoices"
                />
                {fieldError("includedInvoices")}
              </div>
              <div>
                <Label htmlFor="tier-overagePrice">Overage price (₦)</Label>
                <Input
                  id="tier-overagePrice"
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.overagePrice}
                  onChange={(e) =>
                    setForm({ ...form, overagePrice: e.target.value })
                  }
                  {...fieldAria("overagePrice")}
                  data-testid="input-overage-price"
                />
                {fieldError("overagePrice")}
              </div>
              <div>
                <Label htmlFor="tier-revenueSharePct">Revenue share (%)</Label>
                <Input
                  id="tier-revenueSharePct"
                  type="number"
                  min={0}
                  max={100}
                  step="0.1"
                  value={form.revenueSharePct}
                  onChange={(e) =>
                    setForm({ ...form, revenueSharePct: e.target.value })
                  }
                  {...fieldAria("revenueSharePct")}
                  data-testid="input-revenue-share"
                />
                {fieldError("revenueSharePct")}
              </div>
            </div>
            <div>
              <Label htmlFor="tier-effectiveDate">Effective date</Label>
              <Input
                id="tier-effectiveDate"
                type="date"
                value={form.effectiveDate}
                onChange={(e) =>
                  setForm({ ...form, effectiveDate: e.target.value })
                }
                {...fieldAria("effectiveDate")}
                data-testid="input-effective-date"
              />
              {fieldError("effectiveDate")}
            </div>
            <div>
              <Label htmlFor="tier-note">Note</Label>
              <Input
                id="tier-note"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Reason for semi-annual review"
                data-testid="input-review-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditTier(null)}
              data-testid="button-cancel-tier"
            >
              Cancel
            </Button>
            <Button
              onClick={saveTier}
              disabled={updateTier.isPending}
              data-testid="button-save-tier"
            >
              {updateTier.isPending ? "Recording…" : "Record review"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!historyTierId}
        onOpenChange={(o) => !o && setHistoryTierId(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Price review history</DialogTitle>
          </DialogHeader>
          {historyTierId && <PriceReviewHistory tierId={historyTierId} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
