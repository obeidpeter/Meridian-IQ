import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CheckCircle2, Circle, Info, ListChecks, X } from "lucide-react";
import type { GettingStartedStep } from "./helpers";

export function GettingStartedCard({
  steps,
  onAddClient,
  onDismiss,
}: {
  steps: GettingStartedStep[];
  onAddClient: () => void;
  onDismiss: () => void;
}) {
  const icon = (step: GettingStartedStep) =>
    step.kind === "info" ? (
      <Info
        className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    ) : step.done ? (
      <CheckCircle2
        className="w-4 h-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    ) : (
      <Circle
        className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    );

  return (
    <Card
      className="rounded-lg border-teal-200 bg-teal-50/30 shadow-sm dark:border-teal-900 dark:bg-teal-950/20"
      data-testid="card-getting-started"
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <ListChecks className="w-4 h-4 text-primary" aria-hidden="true" />
            Getting started
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            data-testid="button-dismiss-getting-started"
          >
            <X className="w-3.5 h-3.5 mr-1" aria-hidden="true" /> Dismiss
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <ol className="space-y-1.5">
          {steps.map((step) => (
            <li
              key={step.id}
              className="flex items-start gap-2.5 text-sm"
              data-testid={`getting-started-${step.id}`}
            >
              {icon(step)}
              <div className="min-w-0">
                <span
                  className={
                    step.done ? "text-muted-foreground" : "font-medium"
                  }
                >
                  {step.kind === "step" && (
                    <span className="sr-only">
                      {step.done ? "Done — " : "To do — "}
                    </span>
                  )}
                  {step.label}
                </span>
                {step.id === "add-client" && !step.done && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 ml-2 text-sm"
                    onClick={onAddClient}
                    data-testid="button-checklist-add-client"
                  >
                    Add a client
                  </Button>
                )}
                {step.id === "invite-owner" && !step.done && (
                  <Link
                    href="/invitations"
                    className="ml-2 text-primary hover:underline rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    data-testid="link-checklist-invitations"
                  >
                    Send an invite
                  </Link>
                )}
                {step.id === "consent" && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — the client signs in to their own workspace and grants
                    data-sharing consent themselves; this checklist can't see or
                    do it for them.
                  </span>
                )}
                {step.id === "first-invoice" && !step.done && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — raised by the client, or drafted by Clerk from their
                    documents.
                  </span>
                )}
                {step.id === "stamping" && !step.done && (
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    — done once any invoice is pending or stamped on the rails.
                  </span>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
