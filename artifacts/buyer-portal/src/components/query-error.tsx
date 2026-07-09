import { AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Shared failed-fetch state (design language §6). Render it in place of the
 * page's data widgets — the page header stays visible above it — and pass the
 * query's refetch so "Try again" actually retries.
 */
export function QueryError({
  thing,
  onRetry,
}: {
  thing: string;
  onRetry: () => void;
}) {
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" aria-hidden="true" />
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-destructive" data-testid="text-error">
          Unable to load {thing}.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}
