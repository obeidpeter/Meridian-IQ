import { Link } from "wouter";
import { useGetBuyerExposure } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ShieldCheck,
  ShieldAlert,
  Building2,
  FileText,
  BadgeCheck,
} from "lucide-react";
import {
  formatNaira,
  formatCompactNaira,
  formatDateTime,
  pillClasses,
} from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2";

function StatCard({
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
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-xs font-bold text-muted-foreground">{label}</p>
            <p
              className="mt-2 text-2xl font-extrabold tabular-nums"
              title={title}
            >
              {value}
            </p>
          </div>
          <span
            className={`grid size-10 shrink-0 place-items-center rounded-md ${
              tone === "danger"
                ? "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400"
                : tone === "success"
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
                  : "bg-sky-50 text-primary dark:bg-sky-950/50"
            }`}
          >
            <Icon aria-hidden="true" className="size-5" />
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function PageHeader({ computedAt }: { computedAt?: string }) {
  return (
    <div className="border-b border-slate-200 pb-5">
      <h1
        className="text-2xl font-extrabold text-slate-950 md:text-3xl"
        data-testid="text-page-title"
      >
        Supplier verification
      </h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
        Input-VAT exposure across your suppliers
        {computedAt !== undefined && (
          <>
            {" "}
            · refreshed{" "}
            <span data-testid="text-computed-at">
              {formatDateTime(computedAt)}
            </span>
          </>
        )}
      </p>
    </div>
  );
}

export function Suppliers() {
  usePageTitle("Supplier verification");
  const { data, isLoading, error, refetch } = useGetBuyerExposure();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96 max-w-full mt-2" />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-48" />
          </CardHeader>
          <CardContent className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Supplier verification" />
        ) : (
          <QueryError thing="your VAT exposure" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  const breakdown = [...(data.breakdown ?? [])].sort(
    (a, b) => Number(b.vatAtRisk) - Number(a.vatAtRisk),
  );

  return (
    <div className="space-y-6">
      <PageHeader computedAt={data.computedAt} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Protected VAT"
          value={formatCompactNaira(data.protectedVat)}
          title={formatNaira(data.protectedVat)}
          icon={ShieldCheck}
          tone="success"
          testId="stat-protected-vat"
        />
        <StatCard
          label="VAT at risk"
          value={formatCompactNaira(data.atRiskVat)}
          title={formatNaira(data.atRiskVat)}
          icon={ShieldAlert}
          tone="danger"
          testId="stat-at-risk-vat"
        />
        <StatCard
          label="Suppliers"
          value={String(data.supplierCount)}
          icon={Building2}
          testId="stat-suppliers"
        />
        <StatCard
          label="Invoices"
          value={String(data.invoiceCount)}
          icon={FileText}
          testId="stat-invoices"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle id="suppliers-breakdown-heading">
            Per-supplier breakdown
          </CardTitle>
        </CardHeader>
        <CardContent>
          {breakdown.length === 0 ? (
            <div className="py-12 flex flex-col items-center text-center gap-2">
              <Building2
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold" data-testid="text-empty">
                No suppliers in the exposure snapshot yet
              </p>
              <p className="text-sm text-muted-foreground">
                Suppliers appear here once they address invoices to your
                organization on MeridianIQ.
              </p>
            </div>
          ) : (
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Per-supplier breakdown table, scrollable"
            >
              <Table aria-labelledby="suppliers-breakdown-heading">
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead>TIN</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Stamped</TableHead>
                    <TableHead className="text-right">Eligible</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                    <TableHead className="text-right">Protected VAT</TableHead>
                    <TableHead className="text-right">VAT at risk</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {breakdown.map((s) => (
                    <TableRow
                      key={s.supplierPartyId}
                      data-testid={`row-supplier-${s.supplierPartyId}`}
                    >
                      <TableCell className="font-medium">
                        <Link
                          href={`/suppliers/${s.supplierPartyId}`}
                          className={`text-primary hover:underline rounded-sm ${FOCUS_RING}`}
                          aria-label={`View ${s.supplierName}'s invoices`}
                          data-testid={`link-supplier-${s.supplierPartyId}`}
                        >
                          {s.supplierName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {s.supplierTin ?? "—"}
                          </span>
                          {s.tinValidated ? (
                            <span
                              className={pillClasses("emerald")}
                              data-testid={`badge-tin-${s.supplierPartyId}`}
                            >
                              <BadgeCheck
                                className="w-3 h-3"
                                aria-hidden="true"
                              />{" "}
                              Validated
                            </span>
                          ) : (
                            <span
                              className={pillClasses("slate")}
                              data-testid={`badge-tin-${s.supplierPartyId}`}
                            >
                              Unvalidated
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.invoiceCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.stampedCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.eligibleCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNaira(s.totalAmount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                        {formatNaira(s.vatProtected)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium text-red-700 dark:text-red-400">
                        {formatNaira(s.vatAtRisk)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
