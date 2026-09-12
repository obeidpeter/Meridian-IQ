// The invoice detail page's "Submission failed" card (R126 moved it out of
// the page shell): the catalogue cause and fix, Clerk's button-triggered
// explanation, the fix form the shell hands in, and the escalate panel.
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AlertTriangle, LifeBuoy, Sparkles, Wrench } from "lucide-react";
import { pillClasses } from "@/lib/format";
import type { InvoiceAbilities } from "./abilities";
import type { InvoiceDetailState } from "./use-invoice-detail";

export function SubmissionFailedCard({
  state,
  abilities,
  fixForm,
}: {
  state: InvoiceDetailState;
  abilities: InvoiceAbilities;
  fixForm: ReactNode;
}) {
  const { catalogue, errorCode } = state;
  const { canClerkExplain } = abilities;
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base text-destructive">
          <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Submission
          failed
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {catalogue ? (
          <>
            <div>
              <p className="font-medium">What went wrong</p>
              <p className="text-muted-foreground">{catalogue.cause}</p>
            </div>
            <div>
              <p className="font-medium">How to fix it</p>
              <p className="text-muted-foreground">{catalogue.fix}</p>
            </div>
            {errorCode && (
              <p className="text-xs text-muted-foreground">
                Reference code: <span className="font-mono">{errorCode}</span>
                {catalogue.retriable ? " · retriable" : " · not retriable"}
              </p>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">
            This invoice was rejected
            {errorCode ? ` (code ${errorCode})` : ""}. Escalate to your firm for
            hands-on help.
          </p>
        )}

        {/* Clerk's plain-language read: button-triggered (never auto —
            a page view must not spend tokens), grounded server-side in
            the same catalogue entry shown above. */}
        {canClerkExplain && <ClerkExplanation state={state} />}

        {/* Fix & resubmit: edit the failed invoice's content in place
            (PATCH keeps it failed), then resubmit (failed → submitted). */}
        {fixForm}

        {abilities.canWrite && (
          <EscalatePanel state={state} canEdit={abilities.canEdit} />
        )}
      </CardContent>
    </Card>
  );
}

function ClerkExplanation({ state }: { state: InvoiceDetailState }) {
  const { id, explainFailure } = state;
  return explainFailure.data ? (
    <div className="rounded-lg border bg-background p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="font-medium">Clerk&apos;s explanation</p>
        <span
          className={pillClasses(
            explainFailure.data.source === "clerk" ? "blue" : "slate",
          )}
        >
          {explainFailure.data.source === "clerk"
            ? "Clerk-phrased"
            : "Catalogue text"}
        </span>
      </div>
      <p className="text-muted-foreground">{explainFailure.data.explanation}</p>
      <ol className="list-decimal ml-4 space-y-1 text-muted-foreground">
        {explainFailure.data.nextSteps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>
    </div>
  ) : (
    <div className="space-y-1">
      <Button
        variant="outline"
        size="sm"
        onClick={() => explainFailure.mutate({ data: { invoiceId: id } })}
        disabled={explainFailure.isPending}
        data-testid="button-explain-failure"
      >
        <Sparkles className="w-4 h-4 mr-2" aria-hidden="true" />
        {explainFailure.isPending
          ? "Asking Clerk…"
          : "Explain in plain language"}
      </Button>
      {explainFailure.isError && (
        <p className="text-xs text-muted-foreground">
          Clerk couldn&apos;t add anything — the guidance above still applies.
        </p>
      )}
    </div>
  );
}

function EscalatePanel({
  state,
  canEdit,
}: {
  state: InvoiceDetailState;
  canEdit: boolean;
}) {
  const {
    fix,
    openFix,
    showEscalate,
    setShowEscalate,
    reason,
    setReason,
    handleEscalate,
    escalate,
  } = state;
  return !showEscalate ? (
    <div className="flex flex-wrap gap-2">
      {!fix && canEdit && (
        <Button size="sm" onClick={openFix} data-testid="button-open-fix">
          <Wrench className="w-4 h-4 mr-2" aria-hidden="true" /> Fix & resubmit
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => setShowEscalate(true)}>
        <LifeBuoy className="w-4 h-4 mr-2" aria-hidden="true" /> Escalate to my
        firm
      </Button>
    </div>
  ) : (
    <div className="space-y-2">
      <Label htmlFor="escalate-reason" className="sr-only">
        What you've already tried
      </Label>
      <Textarea
        id="escalate-reason"
        placeholder="Describe what you've already tried…"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={handleEscalate}
          disabled={escalate.isPending || !reason.trim()}
        >
          {escalate.isPending ? "Sending…" : "Send to firm"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setShowEscalate(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
