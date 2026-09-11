import { useState } from "react";
import type { OperatorCaseView } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { humanize, priorityBadgeClasses } from "@/lib/format";
import { Clock, Zap, ShieldCheck, LifeBuoy, Sparkles } from "lucide-react";
import { formatDuration } from "./helpers";
import { EscalationItem } from "./escalation-item";

// One case: title line, playbook, Clerk's triage proposal, escalations, the
// handle-time line and the claim / resolve / resolved actions.
export function CaseCard({
  c,
  onClaim,
  onResolve,
  onReplied,
  claiming,
  resolving,
  canAct,
}: {
  c: OperatorCaseView;
  onClaim: (c: OperatorCaseView) => void;
  onResolve: (c: OperatorCaseView, code: string, note: string) => void;
  onReplied: () => void;
  claiming: boolean;
  resolving: boolean;
  canAct: boolean;
}) {
  return (
    <Card data-testid={`card-case-${c.id}`}>
      <CardContent className="pt-6 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold">{c.title}</p>
            <p className="text-xs text-muted-foreground">
              {c.firmName ?? "Firm"}
              {c.clientName ? ` · ${c.clientName}` : ""}
              {c.invoiceNumber ? ` · ${c.invoiceNumber}` : ""}
              {c.errorCode ? ` · ${c.errorCode}` : ""}
            </p>
          </div>
          <span className={`${priorityBadgeClasses(c.priority)} shrink-0`}>
            {humanize(c.priority)}
          </span>
        </div>

        {c.playbook && (
          <div className="rounded-md bg-muted/60 p-3 text-sm space-y-1">
            <p className="font-medium flex items-center gap-1.5">
              <ShieldCheck
                className="w-4 h-4 text-primary"
                aria-hidden="true"
              />{" "}
              Playbook · {c.playbook.category}
            </p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Cause:</span>{" "}
              {c.playbook.cause}
            </p>
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Fix:</span>{" "}
              {c.playbook.fix}
            </p>
          </div>
        )}

        {c.triage?.status === "proposed" && (
          <div
            className="rounded-md border border-violet-200 bg-violet-50/60 dark:border-violet-900 dark:bg-violet-950/40 p-3 text-sm space-y-1"
            data-testid={`triage-${c.id}`}
          >
            <p className="font-medium flex items-center gap-1.5 text-violet-900 dark:text-violet-200">
              <Sparkles className="w-4 h-4" aria-hidden="true" /> Clerk suggests
              · {humanize(c.triage.category ?? "other")}
              {c.triage.priority && c.triage.priority !== c.priority
                ? ` · priority ${c.triage.priority}`
                : ""}
              {c.triage.catalogueCode ? ` · ${c.triage.catalogueCode}` : ""}
            </p>
            {c.triage.rationale && (
              <p className="text-violet-900/80 dark:text-violet-200/80">
                {c.triage.rationale}
              </p>
            )}
            <p className="text-xs text-violet-900/60 dark:text-violet-200/60">
              A proposal, not a decision — you route the case.
            </p>
          </div>
        )}

        {(c.escalations ?? []).length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/40 p-3 text-sm space-y-1.5">
            <p className="font-medium flex items-center gap-1.5 text-amber-900 dark:text-amber-200">
              <LifeBuoy className="w-4 h-4" aria-hidden="true" /> Client
              escalation
            </p>
            {(c.escalations ?? []).map((e) => (
              <EscalationItem
                key={e.id}
                escalation={e}
                canAct={canAct}
                onReplied={onReplied}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" /> Handle:{" "}
            {formatDuration(c.handleSeconds)}
          </span>
          <span>{humanize(c.status)}</span>
        </div>

        <CaseActions
          c={c}
          canAct={canAct}
          claiming={claiming}
          resolving={resolving}
          onClaim={onClaim}
          onResolve={onResolve}
        />
      </CardContent>
    </Card>
  );
}

// The claim button, the resolution note with its retry / resolve buttons,
// and the resolved line. Rendered unconditionally inside the card so the
// typed note lives exactly as long as the card does.
function CaseActions({
  c,
  canAct,
  claiming,
  resolving,
  onClaim,
  onResolve,
}: {
  c: OperatorCaseView;
  canAct: boolean;
  claiming: boolean;
  resolving: boolean;
  onClaim: (c: OperatorCaseView) => void;
  onResolve: (c: OperatorCaseView, code: string, note: string) => void;
}) {
  const [note, setNote] = useState("");

  return (
    <>
      {c.status === "open" && canAct && (
        <Button
          size="sm"
          className="w-full"
          disabled={claiming}
          onClick={() => onClaim(c)}
          data-testid={`button-claim-${c.id}`}
        >
          {claiming ? "Claiming…" : "Claim case"}
        </Button>
      )}

      {c.status === "in_progress" && canAct && (
        <div className="space-y-2">
          <Label htmlFor={`note-${c.id}`} className="sr-only">
            Resolution note
          </Label>
          <Input
            id={`note-${c.id}`}
            placeholder="Resolution note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            data-testid={`input-note-${c.id}`}
          />
          <div className="flex gap-2">
            {c.playbook?.retriable && (
              <Button
                size="sm"
                variant="secondary"
                className="flex-1"
                disabled={resolving}
                onClick={() => onResolve(c, "retried", note)}
                data-testid={`button-retry-${c.id}`}
              >
                <Zap className="w-4 h-4 mr-1" aria-hidden="true" /> Try again
                and resolve
              </Button>
            )}
            <Button
              size="sm"
              className="flex-1"
              disabled={resolving}
              onClick={() => onResolve(c, "resolved_manually", note)}
              data-testid={`button-resolve-${c.id}`}
            >
              {resolving ? "Resolving…" : "Resolve"}
            </Button>
          </div>
        </div>
      )}

      {c.status === "resolved" && (
        <p className="text-xs text-emerald-700 dark:text-emerald-400">
          Resolved{c.resolutionCode ? ` · ${humanize(c.resolutionCode)}` : ""}
          {c.resolutionNote ? ` — ${c.resolutionNote}` : ""}
        </p>
      )}
    </>
  );
}
