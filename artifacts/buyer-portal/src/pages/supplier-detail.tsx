import { Link, useParams } from "wouter";
import { useGetBuyerSupplierDetail } from "@workspace/api-client-react";
import type { BuyerInvoice } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  Building2,
  CheckCircle2,
  ChevronRight,
  FileText,
  Inbox,
  ShieldAlert,
  ShieldCheck,
  Stamp,
} from "lucide-react";
import {
  formatNaira,
  formatCompactNaira,
  formatDate,
  pillClasses,
  confirmationLabel,
  confirmationBadgeClasses,
  stampBadge,
} from "@/lib/format";
import { errorStatus, isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function StatTile({
  label,
  value,
  title,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: string;
  title?: string;
  icon: typeof Building2;
  tone?: "danger" | "success";
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-1 tabular-nums" title={title}>
              {value}
            </p>
          </div>
          <Icon
            aria-hidden="true"
            className={`w-8 h-8 ${
              tone === "danger"
                ? "text-red-500 dark:text-red-400"
                : tone === "success"
                  ? "text-emerald-500 dark:text-emerald-400"
                  : "text-primary"
            }`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DetailInvoiceRow({ invoice }: { invoice: BuyerInvoice }) {
  const stamp = stampBadge(invoice.stampValid);
  return (
    <Link
      href={`/invoices/${invoice.id}`}
      data-testid={`row-invoice-${invoice.id}`}
      className={`flex items-center gap-3 py-3 -mx-2 px-2 rounded-md hover:bg-muted/50 transition-colors ${FOCUS_RING}`}
    >
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{invoice.invoiceNumber}</p>
        <p className="text-xs text-muted-foreground truncate">
          {formatDate(invoice.issueDate)}
          <span className="sm:hidden tabular-nums">
            {" · "}
            {formatNaira(invoice.grandTotal)}
          </span>
        </p>
      </div>
      <span
        className={`hidden lg:inline-flex ${stamp.classes}`}
        data-testid={`badge-stamp-${invoice.id}`}
      >
        {stamp.label}
      </span>
      <p className="text-sm font-medium tabular-nums hidden sm:block">
        {formatNaira(invoice.grandTotal)}
      </p>
      <span
        className={confirmationBadgeClasses(invoice.confirmationState)}
        data-testid={`badge-confirmation-${invoice.id}`}
      >
        {confirmationLabel(invoice.confirmationState)}
      </span>
      <ChevronRight
        className="w-4 h-4 text-muted-foreground shrink-0"
        aria-hidden="true"
      />
    </Link>
  );
}

export function SupplierDetail() {
  const params = useParams();
  const id = params.id as string;
  const { data, isLoading, error, refetch } = useGetBuyerSupplierDetail(id);
  usePageTitle(data ? data.supplier.supplierName : "Supplier");

  const backLink = (
    <Link
      href="/suppliers"
      className={`inline-flex items-center gap-2 text-sm text-primary rounded-sm ${FOCUS_RING}`}
      data-testid="link-back"
    >
      <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to suppliers
    </Link>
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {backLink}
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-48 max-w-full mt-2" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    // The endpoint 404s for a supplier that never invoiced this buyer (or a
    // stale link) — the portal's unknown-entity idiom, not a retry loop.
    if (errorStatus(error) === 404) {
      return (
        <div className="space-y-4">
          {backLink}
          <Card data-testid="card-unknown-supplier">
            <CardContent className="py-12 flex flex-col items-center text-center gap-2">
              <Building2
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-error">
                We couldn't find this supplier
              </p>
              <p className="text-sm text-muted-foreground max-w-md">
                They may not have addressed any invoices to your organization,
                or the link may be out of date.
              </p>
              <Button
                asChild
                variant="outline"
                data-testid="button-back-to-suppliers"
              >
                <Link href="/suppliers">Back to suppliers</Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        {backLink}
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Supplier verification" />
        ) : (
          <QueryError thing="this supplier" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const { supplier, invoices } = data;

  return (
    <div className="space-y-6">
      {backLink}

      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          {supplier.supplierName}
        </h1>
        <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5">
          TIN{" "}
          <span data-testid="text-supplier-tin">
            {supplier.supplierTin ?? "—"}
          </span>
          {supplier.tinValidated ? (
            <span
              className={pillClasses("emerald")}
              data-testid="badge-tin-validated"
            >
              <BadgeCheck className="w-3 h-3" aria-hidden="true" /> Validated
            </span>
          ) : (
            <span
              className={pillClasses("slate")}
              data-testid="badge-tin-validated"
            >
              Unvalidated
            </span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatTile
          label="Invoices"
          value={String(supplier.invoiceCount)}
          icon={FileText}
          testId="stat-invoices"
        />
        <StatTile
          label="Stamped"
          value={String(supplier.stampedCount)}
          icon={Stamp}
          testId="stat-stamped"
        />
        <StatTile
          label="Eligible"
          value={String(supplier.eligibleCount)}
          icon={CheckCircle2}
          testId="stat-eligible"
        />
        <StatTile
          label="Total"
          value={formatCompactNaira(supplier.totalAmount)}
          title={formatNaira(supplier.totalAmount)}
          icon={Banknote}
          testId="stat-total"
        />
        <StatTile
          label="Protected VAT"
          value={formatCompactNaira(supplier.vatProtected)}
          title={formatNaira(supplier.vatProtected)}
          icon={ShieldCheck}
          tone="success"
          testId="stat-protected-vat"
        />
        <StatTile
          label="VAT at risk"
          value={formatCompactNaira(supplier.vatAtRisk)}
          title={formatNaira(supplier.vatAtRisk)}
          icon={ShieldAlert}
          tone="danger"
          testId="stat-at-risk-vat"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invoices from this supplier</CardTitle>
        </CardHeader>
        <CardContent>
          {invoices.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-2">
              <Inbox
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-empty">
                No invoices from this supplier yet
              </p>
              <p className="text-sm text-muted-foreground">
                Invoices appear here when this supplier addresses them to your
                organization on MeridianIQ.
              </p>
            </div>
          ) : (
            <div className="divide-y">
              {invoices.map((inv) => (
                <DetailInvoiceRow key={inv.id} invoice={inv} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
