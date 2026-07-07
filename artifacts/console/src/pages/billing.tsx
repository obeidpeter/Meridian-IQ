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
import { useToast } from "@/hooks/use-toast";
import { Check, History, Pencil } from "lucide-react";
import { formatNaira, formatDate } from "@/lib/format";

function pct(v: string) {
  return `${(Number(v) * 100).toFixed(1)}%`;
}

function PriceReviewHistory({ tierId }: { tierId: string }) {
  const { data, isLoading } = useListPriceReviews(tierId);
  if (isLoading) return <Skeleton className="h-24" />;
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
            <span className="font-medium capitalize">
              {r.field.replace(/_/g, " ")}
            </span>
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

export function Billing() {
  const { data: tiers, isLoading: tiersLoading } = useListTiers();
  const { data: subscription, isLoading: subLoading } = useGetSubscription();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const updateTier = useUpdateTier();
  const updateSubscription = useUpdateSubscription();

  const [editTier, setEditTier] = useState<BillingTier | null>(null);
  const [historyTierId, setHistoryTierId] = useState<string | null>(null);
  const [form, setForm] = useState({
    monthlyPrice: "",
    includedInvoices: "",
    overagePrice: "",
    revenueSharePct: "",
    effectiveDate: "",
    note: "",
  });

  const openEdit = (t: BillingTier) => {
    setEditTier(t);
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
      },
    );
  };

  const activeKey = subscription?.tier.key;

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
      ) : subscription ? (
        <Card className="bg-accent/40" data-testid="card-current-plan">
          <CardContent className="pt-6 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm text-muted-foreground">Current plan</p>
              <p className="text-xl font-bold">{subscription.tier.name}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold">
                {formatNaira(subscription.tier.monthlyPrice)}/mo
              </p>
              <p className="text-xs text-muted-foreground">
                {subscription.tier.includedInvoices} invoices included ·{" "}
                {pct(subscription.tier.revenueSharePct)} revenue share ·{" "}
                {subscription.status}
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
                    <p className="text-2xl font-bold">
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
                        disabled={isCurrent || updateSubscription.isPending}
                        onClick={() => selectPlan(t)}
                        data-testid={`button-select-${t.key}`}
                      >
                        {isCurrent ? (
                          <>
                            <Check className="w-4 h-4 mr-1" /> Selected
                          </>
                        ) : (
                          "Select"
                        )}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => openEdit(t)}
                        data-testid={`button-edit-${t.key}`}
                      >
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setHistoryTierId(t.id)}
                        data-testid={`button-history-${t.key}`}
                      >
                        <History className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

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
                <Label htmlFor="mp">Monthly price (₦)</Label>
                <Input
                  id="mp"
                  value={form.monthlyPrice}
                  onChange={(e) =>
                    setForm({ ...form, monthlyPrice: e.target.value })
                  }
                  data-testid="input-monthly-price"
                />
              </div>
              <div>
                <Label htmlFor="inc">Included invoices</Label>
                <Input
                  id="inc"
                  type="number"
                  value={form.includedInvoices}
                  onChange={(e) =>
                    setForm({ ...form, includedInvoices: e.target.value })
                  }
                  data-testid="input-included-invoices"
                />
              </div>
              <div>
                <Label htmlFor="ov">Overage price (₦)</Label>
                <Input
                  id="ov"
                  value={form.overagePrice}
                  onChange={(e) =>
                    setForm({ ...form, overagePrice: e.target.value })
                  }
                  data-testid="input-overage-price"
                />
              </div>
              <div>
                <Label htmlFor="rs">Revenue share (%)</Label>
                <Input
                  id="rs"
                  value={form.revenueSharePct}
                  onChange={(e) =>
                    setForm({ ...form, revenueSharePct: e.target.value })
                  }
                  data-testid="input-revenue-share"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ed">Effective date</Label>
              <Input
                id="ed"
                type="date"
                value={form.effectiveDate}
                onChange={(e) =>
                  setForm({ ...form, effectiveDate: e.target.value })
                }
                data-testid="input-effective-date"
              />
            </div>
            <div>
              <Label htmlFor="nt">Note</Label>
              <Input
                id="nt"
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                placeholder="Reason for semi-annual review"
                data-testid="input-review-note"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={saveTier}
              disabled={updateTier.isPending}
              data-testid="button-save-tier"
            >
              Record review
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
