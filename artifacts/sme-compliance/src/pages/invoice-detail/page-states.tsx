// The invoice detail page's non-record states (R126 moved them out of the
// page shell): the loading skeleton, the fetch-failure retry state and the
// not-found card, plus the "Back to vault" link every state opens with.
import { Link } from "wouter";
import { ArrowLeft, FileQuestion } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";

export function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-5 w-32" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-9 w-44" />
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export function BackToVault() {
  return (
    <Link
      href="/invoices"
      className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="w-4 h-4 mr-1" aria-hidden="true" /> Back to vault
    </Link>
  );
}

export function DetailLoadError({ onRetry }: { onRetry: () => void }) {
  // A fetch failure (network blip, 5xx) is not a missing invoice — show the
  // shared destructive error state with a retry, matching the other apps.
  return (
    <div className="space-y-6">
      <BackToVault />
      <QueryError thing="this invoice" onRetry={onRetry} />
    </div>
  );
}

export function UnknownInvoice() {
  // Genuinely missing record (404): neutral not-found card.
  return (
    <div className="space-y-6">
      <BackToVault />
      <Card data-testid="card-unknown-invoice">
        <EmptyState
          icon={FileQuestion}
          title="We couldn't find this invoice"
          testId="text-error"
          description="It may have been removed, or the link may be out of date."
        >
          <Button asChild className="mt-2">
            <Link href="/invoices">Back to vault</Link>
          </Button>
        </EmptyState>
      </Card>
    </div>
  );
}
