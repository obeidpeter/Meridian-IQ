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
import { formatNaira, formatDateTime } from "@/lib/format";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";

function StatCard({
  label,
  value,
  icon: Icon,
  tone,
  testId,
}: {
  label: string;
  value: string;
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
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon
            className={`w-8 h-8 ${
              tone === "danger"
                ? "text-red-500"
                : tone === "success"
                  ? "text-emerald-500"
                  : "text-primary"
            }`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

export function Suppliers() {
  const { data, isLoading, error } = useGetBuyerExposure();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !data) {
    if (isFeatureDisabled(error)) {
      return (
        <div className="space-y-6">
          <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
            Supplier verification
          </h1>
          <FeatureUnavailable feature="Supplier verification" />
        </div>
      );
    }
    return (
      <p className="text-destructive" data-testid="text-error">
        Unable to load your VAT exposure.
      </p>
    );
  }

  const breakdown = [...data.breakdown].sort(
    (a, b) => Number(b.vatAtRisk) - Number(a.vatAtRisk),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          Supplier verification
        </h1>
        <p className="text-muted-foreground mt-1">
          Input-VAT exposure across your suppliers · refreshed{" "}
          <span data-testid="text-computed-at">
            {formatDateTime(data.computedAt)}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Protected VAT"
          value={formatNaira(data.protectedVat)}
          icon={ShieldCheck}
          tone="success"
          testId="stat-protected-vat"
        />
        <StatCard
          label="VAT at risk"
          value={formatNaira(data.atRiskVat)}
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
          <CardTitle>Per-supplier breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          {breakdown.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-empty">
              No suppliers in the exposure snapshot yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
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
                        {s.supplierName}
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {s.supplierTin ?? "—"}
                          </span>
                          {s.tinValidated ? (
                            <span
                              className="inline-flex items-center gap-0.5 text-xs font-medium px-2 py-0.5 rounded-full border bg-emerald-100 text-emerald-800 border-emerald-200"
                              data-testid={`badge-tin-${s.supplierPartyId}`}
                            >
                              <BadgeCheck className="w-3 h-3" /> Validated
                            </span>
                          ) : (
                            <span
                              className="text-xs font-medium px-2 py-0.5 rounded-full border bg-slate-100 text-slate-600 border-slate-200"
                              data-testid={`badge-tin-${s.supplierPartyId}`}
                            >
                              Unvalidated
                            </span>
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        {s.invoiceCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {s.stampedCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {s.eligibleCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {formatNaira(s.totalAmount)}
                      </TableCell>
                      <TableCell className="text-right text-emerald-700">
                        {formatNaira(s.vatProtected)}
                      </TableCell>
                      <TableCell className="text-right font-medium text-red-700">
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
