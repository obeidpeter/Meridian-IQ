import { useState } from "react";
import {
  useVerifyAudit,
  useExportAudit,
  getVerifyAuditQueryKey,
  getExportAuditQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import {
  ShieldCheck,
  ShieldAlert,
  Download,
  Link2,
  FileJson,
  FileSpreadsheet,
} from "lucide-react";

// CORE-05: the hash-chained audit log is the artifact a regulator, a bank or
// an acquirer reads. This page proves the chain live and hands over the
// verifiable bundle — evidence on demand, not on request-to-engineering.

export function AuditEvidence() {
  usePageTitle("Audit & evidence");
  const { data: verification, isLoading, error, refetch } = useVerifyAudit({
    query: { queryKey: getVerifyAuditQueryKey() },
  });
  const [exporting, setExporting] = useState(false);
  const exportQuery = useExportAudit({
    query: { queryKey: getExportAuditQueryKey(), enabled: false },
  });
  const { toast } = useToast();

  const downloadBundle = async () => {
    setExporting(true);
    try {
      const { data: bundle } = await exportQuery.refetch({ throwOnError: true });
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meridianiq-audit-bundle-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({
        title: "Audit bundle downloaded",
        description: `${bundle?.events.length ?? 0} events with chain verification attached.`,
      });
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  // CSV as a plain browser navigation (no react-query): the endpoint answers
  // with a Content-Disposition attachment and auth rides the session cookie,
  // so the browser just downloads the file.
  const downloadCsv = () => {
    window.location.assign("/api/audit/export/csv");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Audit & evidence
        </h1>
        <p className="text-muted-foreground mt-1">
          Tamper-evident, hash-chained log of every material event — verify it
          live, export it whole.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-36" />
      ) : error || !verification ? (
        // A failed fetch is not a broken chain — never raise the sev-zero
        // card on a network blip; offer a retry instead.
        <QueryError thing="audit verification" onRetry={() => refetch()} />
      ) : verification.valid ? (
        <Card
          className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40"
          data-testid="card-chain-valid"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-emerald-800 dark:text-emerald-300">
              <ShieldCheck className="w-5 h-5" aria-hidden="true" /> Chain
              verified
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm space-y-1">
            <p>
              All{" "}
              <span className="font-semibold">{verification.count}</span> audit
              events hash-chain correctly — no row has been altered or removed.
            </p>
            <p className="text-muted-foreground flex items-center gap-1.5">
              <Link2 className="w-3.5 h-3.5" aria-hidden="true" /> Each event's
              hash covers its content plus the previous event's hash; breaking
              any link breaks every link after it.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card
          className="border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/40"
          data-testid="card-chain-broken"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-red-800 dark:text-red-300">
              <ShieldAlert className="w-5 h-5" aria-hidden="true" /> Chain
              verification failed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>
              The chain breaks at sequence{" "}
              <span className="font-mono font-semibold">
                {verification.brokenAtSeq ?? "?"}
              </span>{" "}
              of {verification.count ?? "?"} events. Treat as a sev-zero
              incident (SEC-10) — records after the break cannot be trusted.
            </p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-export">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileJson className="w-4 h-4 text-primary" aria-hidden="true" /> Verifiable export
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            The bundle contains every audit event plus the chain verification
            result, self-contained so a third party can re-verify the hashes
            without access to this system. The CSV ledger is its
            spreadsheet-friendly companion — each row carries its hash, but the
            JSON bundle stays the verifiable artifact.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={downloadBundle}
              disabled={exporting}
              data-testid="button-export-bundle"
            >
              <Download className="w-4 h-4 mr-1" aria-hidden="true" />
              {exporting ? "Preparing bundle…" : "Download audit bundle"}
            </Button>
            <Button
              variant="secondary"
              onClick={downloadCsv}
              data-testid="button-export-csv"
            >
              <FileSpreadsheet className="w-4 h-4 mr-1" aria-hidden="true" />
              Download CSV ledger
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
