import { useCallback, useEffect, useState } from "react";
import {
  verifyAudit,
  exportAudit,
  type AuditEvent,
  type AuditVerification,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WorkspaceHeader } from "@workspace/web-ui";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";
import { downloadBlob } from "@/lib/download";
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
//
// Bounded reads (R98): the ledger is verified and exported in WINDOWS. Each
// call answers for at most VERIFY_WINDOW / EXPORT_WINDOW events and says
// where the next window starts (`lastSeq`, `complete`), so a ledger of any
// size is walked in bounded requests instead of one that grows with it.
const VERIFY_WINDOW = 5000;
const EXPORT_WINDOW = 5000;

type ChainState =
  | { phase: "loading"; count: number }
  | { phase: "error"; error: unknown }
  | {
      phase: "done";
      valid: boolean;
      count: number;
      brokenAtSeq: number | null;
    };

/** Walk the whole chain window by window; the count is the running total. */
async function verifyWholeChain(
  onProgress: (count: number) => void,
): Promise<{ valid: boolean; count: number; brokenAtSeq: number | null }> {
  let afterSeq: number | undefined;
  let count = 0;
  for (;;) {
    const window: AuditVerification = await verifyAudit({
      ...(afterSeq !== undefined ? { afterSeq } : {}),
      limit: VERIFY_WINDOW,
    });
    count += window.count;
    onProgress(count);
    if (!window.valid) {
      return { valid: false, count, brokenAtSeq: window.brokenAtSeq ?? null };
    }
    if (window.complete || window.lastSeq === null || window.lastSeq === undefined) {
      return { valid: true, count, brokenAtSeq: null };
    }
    afterSeq = window.lastSeq;
  }
}

function useChainVerification() {
  const [state, setState] = useState<ChainState>({ phase: "loading", count: 0 });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ phase: "loading", count: 0 });
    verifyWholeChain((count) => {
      if (!cancelled) setState({ phase: "loading", count });
    })
      .then((result) => {
        if (!cancelled) setState({ phase: "done", ...result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ phase: "error", error });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);
  const refetch = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, refetch };
}

export function AuditEvidence() {
  usePageTitle("Audit & evidence");
  const { state: verification, refetch } = useChainVerification();
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  // The bundle is assembled from export windows and downloaded whole; the
  // verification attached is the roll-up of every window's result.
  const downloadBundle = async () => {
    setExporting(true);
    try {
      const events: AuditEvent[] = [];
      let afterSeq: number | undefined;
      let valid = true;
      let brokenAtSeq: number | null = null;
      let checked = 0;
      let lastSeq: number | null = null;
      for (;;) {
        const window = await exportAudit({
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          limit: EXPORT_WINDOW,
        });
        events.push(...window.events);
        checked += window.verification.count;
        if (!window.verification.valid) {
          valid = false;
          brokenAtSeq = window.verification.brokenAtSeq ?? null;
          break;
        }
        lastSeq = window.lastSeq ?? lastSeq;
        if (window.complete || window.lastSeq === null || window.lastSeq === undefined) break;
        afterSeq = window.lastSeq;
      }
      const bundle = {
        events,
        verification: { valid, count: checked, brokenAtSeq, lastSeq, complete: valid },
        exportedAt: new Date().toISOString(),
        lastSeq,
        complete: valid,
      };
      downloadBlob(
        `valo-audit-bundle-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(bundle, null, 2),
        "application/json",
      );
      toast({
        title: "Audit bundle downloaded",
        description: `${events.length} events with chain verification attached.`,
      });
    } catch (e) {
      serverErrorToast(toast, e, {
        title: "Export failed",
        fallback: "Try again.",
      });
    } finally {
      setExporting(false);
    }
  };

  // CSV as a plain browser navigation (no react-query): the endpoint answers
  // with a Content-Disposition attachment and auth rides the session cookie,
  // so the browser just downloads the file (the first 50,000 rows; the
  // X-Audit-Last-Seq header names the afterSeq for the next file).
  const downloadCsv = () => {
    window.location.assign("/api/audit/export/csv");
  };

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Evidence"
        title="Audit & evidence"
        titleTestId="text-page-title"
        description="Tamper-evident, hash-chained log of every material event — verify it live, export it whole."
      />

      {verification.phase === "loading" ? (
        <div className="space-y-2">
          <Skeleton className="h-36" />
          {verification.count > 0 && (
            <p
              className="text-sm text-muted-foreground"
              data-testid="text-verify-progress"
            >
              Verified {verification.count} events so far…
            </p>
          )}
        </div>
      ) : verification.phase === "error" ? (
        // A failed fetch is not a broken chain — never raise the sev-zero
        // card on a network blip; offer a retry instead.
        <QueryError thing="audit verification" onRetry={refetch} />
      ) : verification.valid ? (
        <Card
          className="border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/40"
          data-testid="card-chain-valid"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2.5 text-base text-emerald-800 dark:text-emerald-300">
              <span className="mi-card-icon" data-tone="positive">
                <ShieldCheck aria-hidden="true" />
              </span>
              Chain verified
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
            <CardTitle className="flex items-center gap-2.5 text-base text-red-800 dark:text-red-300">
              <span className="mi-card-icon" data-tone="critical">
                <ShieldAlert aria-hidden="true" />
              </span>
              Chain verification failed
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>
              The chain breaks at sequence{" "}
              <span className="font-mono font-semibold">
                {verification.brokenAtSeq ?? "?"}
              </span>{" "}
              after {verification.count} verified events. Treat as a sev-zero
              incident (SEC-10) — records after the break cannot be trusted.
            </p>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-export">
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5 text-base">
            <span className="mi-card-icon">
              <FileJson aria-hidden="true" />
            </span>
            Verifiable export
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
