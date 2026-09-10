// The buyer confirmation queue (R126 split the 971-line page into this
// shell, the queue and bulk-confirm state hooks, the pure counts helper,
// one module per card and the row). The route (App.tsx) and the unit suite
// (confirmations.test.tsx) keep importing "@/pages/confirmations" /
// "./confirmations": this module is the page's surface.

import { getExportBuyerConfirmationsUrl } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { isFeatureDisabled } from "@/lib/errors";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { WorkspaceHeader } from "@workspace/web-ui";
import { PageHeader, QueueSkeleton } from "./layout";
import { useConfirmationsPage } from "./use-confirmations-page";
import { QueueMetrics } from "./queue-metrics";
import { AwaitingCard } from "./awaiting-card";
import { BulkResultsCard } from "./bulk-results-card";
import { QueueFilters } from "./queue-filters";
import { InvoiceQueueCard } from "./invoice-queue-card";

export function Confirmations() {
  const state = useConfirmationsPage();
  const {
    data,
    isLoading,
    error,
    refetch,
    awaitingCount,
    bulkResults,
    setBulkResults,
    skippedItems,
    numbersById,
  } = state;

  if (isLoading) return <QueueSkeleton />;

  if (error || !data) {
    return (
      <div className="space-y-6">
        <PageHeader />
        {isFeatureDisabled(error) ? (
          <FeatureUnavailable feature="Buyer Rails" />
        ) : (
          <QueryError thing="your invoices" onRetry={() => refetch()} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Buyer controls"
        title="Confirmations"
        description="Review supplier invoices, protect input VAT evidence and record each response."
        actions={
          // CSV of the confirmation queue, as a plain same-origin navigation
          // (no react-query): the endpoint answers with a Content-Disposition
          // attachment and auth rides the session cookie, so the browser just
          // downloads the file.
          <Button
            asChild
            variant="outline"
            data-testid="button-export-confirmations"
          >
            <a href={getExportBuyerConfirmationsUrl()}>
              <Download className="w-4 h-4 mr-2" aria-hidden="true" />
              Export CSV
            </a>
          </Button>
        }
      />

      <QueueMetrics state={state} />

      {awaitingCount > 0 && <AwaitingCard state={state} />}

      {bulkResults !== null && (
        <BulkResultsCard
          results={bulkResults}
          skippedItems={skippedItems}
          numbersById={numbersById}
          onDismiss={() => setBulkResults(null)}
        />
      )}

      <QueueFilters state={state} />

      <InvoiceQueueCard state={state} />
    </div>
  );
}
