import { Link } from "wouter";
import {
  useGetClerkCase,
  getGetClerkCaseQueryKey,
} from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { QueryError } from "@/components/query-error";
import { fieldLabel, captureStatusExplanation } from "@/lib/clerk";
import { AlertTriangle, FileCheck2 } from "lucide-react";

// Read-only detail for the expanded submission row: what Clerk extracted,
// why a read failed, and — once approved — the draft-invoice hand-off note.
export function CaseDetail({ caseId }: { caseId: string }) {
  const {
    data: kase,
    isLoading,
    isError,
    refetch,
  } = useGetClerkCase(caseId, {
    query: { queryKey: getGetClerkCaseQueryKey(caseId) },
  });

  if (isLoading) {
    return <Skeleton className="h-24" data-testid="skeleton-case-detail" />;
  }
  if (isError || !kase) {
    return <QueryError thing="this submission" onRetry={() => refetch()} />;
  }

  return (
    <div
      className="space-y-3 border-t pt-3"
      data-testid={`detail-case-${kase.id}`}
    >
      {kase.status === "failed" && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Clerk could not read this</AlertTitle>
          <AlertDescription>
            {kase.failReason ??
              "The document was unreadable. Try a clearer photo or paste the text instead."}
          </AlertDescription>
        </Alert>
      )}

      {kase.status === "approved" && (
        <Alert data-testid="banner-draft-created">
          <FileCheck2 className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Draft invoice created</AlertTitle>
          <AlertDescription>
            Draft invoice created — your accountant will take it from here.
            {kase.createdInvoiceId && (
              <>
                {" "}
                <Link
                  href={`/invoices/${kase.createdInvoiceId}`}
                  className="text-primary hover:underline font-medium"
                  data-testid="link-created-invoice"
                >
                  View the draft
                </Link>
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {kase.status === "rejected" && kase.decisionReason && (
        <p className="text-sm text-muted-foreground">
          Reason: {kase.decisionReason}
        </p>
      )}

      {captureStatusExplanation(kase.status, kase.decisionReason) && (
        <p
          className="text-sm text-muted-foreground"
          data-testid={`text-case-explanation-${kase.status}`}
        >
          {captureStatusExplanation(kase.status, kase.decisionReason)}
        </p>
      )}

      {kase.status === "pending" && (
        <p className="text-sm text-muted-foreground">
          Clerk is reading your submission — check back in a moment.
        </p>
      )}

      {(kase.status === "extracted" || kase.status === "in_review") && (
        <p className="text-sm text-muted-foreground">
          Your accountant reviews everything below before anything is created.
        </p>
      )}

      {kase.extraction && (
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase mb-1.5">
            What Clerk read
          </p>
          <div className="divide-y text-sm">
            {kase.extraction.fields.map((f) => (
              <div
                key={f.field}
                className="flex items-center gap-3 px-1 py-2"
                data-testid={`row-field-${f.field}`}
              >
                <span className="w-36 shrink-0 text-muted-foreground">
                  {fieldLabel(f.field)}
                </span>
                <span className="flex-1 truncate text-right font-medium">
                  {f.value ?? (
                    <em className="text-muted-foreground font-normal">
                      missing
                    </em>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
