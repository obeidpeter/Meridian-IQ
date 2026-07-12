import { useState } from "react";
import { Link, useParams } from "wouter";
import {
  useGetMe,
  useGetClerkCase,
  useReviewClerkCase,
  getGetClerkCaseQueryKey,
  getListClerkCasesQueryKey,
} from "@workspace/api-client-react";
import type {
  ClerkFieldCandidate,
  ClerkReviewInputDecision,
  ClerkReviewInputFieldsItem,
  ClerkReviewInputFieldsItemAction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import {
  clerkCaseStateBadgeClasses,
  clerkCaseStateLabel,
  clerkConfidenceBadgeClasses,
  clerkRunOutcomeBadgeClasses,
  formatDateTime,
  humanize,
  pillClasses,
  priorityBadgeClasses,
} from "@/lib/format";
import {
  ArrowLeft,
  Check,
  FileText,
  Pencil,
  SearchX,
  ShieldAlert,
  X,
} from "lucide-react";

// CLK-OPS-01 source-to-field evidence: the reviewer sees the raw source next
// to every extracted candidate, confirms or corrects each one, and records a
// decision with a reason code. Critical fields must be explicitly confirmed
// before approval — the API enforces it with a 409 naming the stragglers.

type StagedAction = {
  action: ClerkReviewInputFieldsItemAction;
  value?: string;
};

const REVIEWABLE_STATES = new Set(["ready_for_review", "clarification_required"]);

function SourcePane({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div
      className="rounded-md border bg-muted/40 font-mono text-xs max-h-[32rem] overflow-auto"
      data-testid="source-text"
    >
      <div className="min-w-max p-3">
        {lines.map((line, i) => (
          <div key={i} className="flex gap-3">
            <span className="w-8 shrink-0 text-right text-muted-foreground select-none tabular-nums">
              {i + 1}
            </span>
            <span className="whitespace-pre">{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  candidate,
  reviewable,
  staged,
  onStage,
  onUnstage,
}: {
  candidate: ClerkFieldCandidate;
  reviewable: boolean;
  staged: StagedAction | undefined;
  onStage: (id: string, action: StagedAction) => void;
  onUnstage: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const confidence = Number(candidate.confidence);
  const displayValue =
    staged?.action === "edit" && staged.value !== undefined
      ? staged.value
      : (candidate.editedValue ?? candidate.value);

  return (
    <TableRow data-testid={`row-candidate-${candidate.id}`}>
      <TableCell className="font-mono text-xs font-medium">
        {candidate.fieldKey}
        {candidate.critical && (
          <ShieldAlert
            className="w-3.5 h-3.5 inline-block ml-1.5 text-amber-600 dark:text-amber-400 align-text-bottom"
            aria-label="Critical field"
          />
        )}
      </TableCell>
      <TableCell className="max-w-48">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              className="h-8"
              aria-label={`New value for ${candidate.fieldKey}`}
              data-testid={`input-edit-${candidate.id}`}
            />
            <Button
              size="sm"
              variant="secondary"
              className="h-8 px-2"
              disabled={!editValue.trim()}
              onClick={() => {
                onStage(candidate.id, { action: "edit", value: editValue.trim() });
                setEditing(false);
              }}
              data-testid={`button-save-edit-${candidate.id}`}
            >
              <Check className="w-4 h-4" aria-hidden="true" />
              <span className="sr-only">Save edit</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2"
              onClick={() => setEditing(false)}
              aria-label="Cancel edit"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <span className="text-sm break-words">{displayValue}</span>
        )}
      </TableCell>
      <TableCell>
        <span className={clerkConfidenceBadgeClasses(confidence)}>
          {Math.round(confidence * 100)}%
        </span>
      </TableCell>
      <TableCell>
        {staged ? (
          <span
            className={pillClasses(
              staged.action === "reject" ? "red" : "blue",
            )}
            data-testid={`staged-${candidate.id}`}
          >
            {humanize(staged.action)} (staged)
          </span>
        ) : (
          <span
            className={pillClasses(
              candidate.reviewState === "confirmed" ||
                candidate.reviewState === "edited"
                ? "emerald"
                : candidate.reviewState === "rejected"
                  ? "red"
                  : "slate",
            )}
          >
            {humanize(candidate.reviewState)}
          </span>
        )}
      </TableCell>
      {reviewable && (
        <TableCell className="text-right whitespace-nowrap">
          {staged ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onUnstage(candidate.id)}
              data-testid={`button-unstage-${candidate.id}`}
            >
              Undo
            </Button>
          ) : (
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="secondary"
                className="h-8 px-2"
                onClick={() => onStage(candidate.id, { action: "confirm" })}
                data-testid={`button-confirm-${candidate.id}`}
              >
                <Check className="w-4 h-4 mr-1" aria-hidden="true" /> Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2"
                onClick={() => {
                  setEditValue(displayValue);
                  setEditing(true);
                }}
                data-testid={`button-edit-${candidate.id}`}
              >
                <Pencil className="w-4 h-4 mr-1" aria-hidden="true" /> Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-destructive hover:text-destructive"
                onClick={() => onStage(candidate.id, { action: "reject" })}
                data-testid={`button-reject-${candidate.id}`}
              >
                <X className="w-4 h-4 mr-1" aria-hidden="true" /> Reject
              </Button>
            </div>
          )}
        </TableCell>
      )}
    </TableRow>
  );
}

export function ClerkCase() {
  const params = useParams();
  const id = params.id as string;
  usePageTitle("Clerk case review");
  const { data: me } = useGetMe();
  const canReview = (me?.capabilities ?? []).includes("clerk.review");
  const { data, isLoading, error, refetch } = useGetClerkCase(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const review = useReviewClerkCase();

  const [staged, setStaged] = useState<Record<string, StagedAction>>({});
  const [reasonCode, setReasonCode] = useState("");
  // Per-decision pending: only the button that fired shows a spinner label.
  const [pendingDecision, setPendingDecision] =
    useState<ClerkReviewInputDecision | null>(null);

  const stage = (candidateId: string, action: StagedAction) =>
    setStaged((s) => ({ ...s, [candidateId]: action }));
  const unstage = (candidateId: string) =>
    setStaged((s) => {
      const next = { ...s };
      delete next[candidateId];
      return next;
    });

  const submitDecision = (decision: ClerkReviewInputDecision) => {
    if (reasonCode.trim().length < 2) return;
    const fields: ClerkReviewInputFieldsItem[] = Object.entries(staged).map(
      ([candidateId, a]) => ({
        candidateId,
        action: a.action,
        value: a.value,
      }),
    );
    setPendingDecision(decision);
    review.mutate(
      {
        id,
        data: {
          decision,
          reasonCode: reasonCode.trim(),
          fields: fields.length > 0 ? fields : undefined,
        },
      },
      {
        onSuccess: (detail) => {
          toast({
            title: `Decision recorded: ${humanize(decision)}`,
            description: `The case is now ${clerkCaseStateLabel(detail.case.state).toLowerCase()}.`,
          });
          setStaged({});
          setReasonCode("");
          queryClient.invalidateQueries({
            queryKey: getGetClerkCaseQueryKey(id),
          });
          queryClient.invalidateQueries({
            queryKey: getListClerkCasesQueryKey(),
          });
        },
        onError: (err) => {
          // The 409 names any critical fields still unconfirmed — surface it.
          toast({
            title: "Could not record the decision",
            description: serverErrorMessage(err),
            variant: "destructive",
          });
        },
        onSettled: () => setPendingDecision(null),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Skeleton className="h-96" />
          <Skeleton className="h-96" />
        </div>
        <Skeleton className="h-24" />
      </div>
    );
  }

  if (error) {
    // Flag-off answers a bodyless 404; a missing case answers { error: … }.
    const missing =
      isFeatureDisabled(error) &&
      typeof (error as { data?: { error?: unknown } }).data?.error === "string";
    if (missing) {
      return (
        <div className="space-y-6">
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Clerk case review
          </h1>
          <Card data-testid="card-case-not-found">
            <CardContent className="py-12 flex flex-col items-center text-center gap-2">
              <SearchX
                className="w-10 h-10 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="font-semibold">Case not found</p>
              <p className="text-sm text-muted-foreground">
                It may belong to another firm, or the id is wrong.
              </p>
              <Button size="sm" variant="outline" asChild>
                <Link href="/clerk" data-testid="link-back-to-queue">
                  Back to the queue
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      );
    }
    if (isFeatureDisabled(error)) {
      return (
        <div className="space-y-6">
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Clerk case review
          </h1>
          <FeatureUnavailable feature="Clerk" />
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Clerk case review
        </h1>
        <QueryError thing="the Clerk case" onRetry={() => refetch()} />
      </div>
    );
  }

  if (!data) return null;
  const { case: c, sources, candidates, runs, decisions } = data;
  const reviewable = REVIEWABLE_STATES.has(c.state) && canReview;
  const sourceText = sources[0]?.contentText ?? "";
  const stagedCount = Object.keys(staged).length;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/clerk"
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1 mb-2"
          data-testid="link-back"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Clerk workspace
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Case review
          </h1>
          <span
            className={clerkCaseStateBadgeClasses(c.state)}
            data-testid="badge-case-state"
          >
            {clerkCaseStateLabel(c.state)}
          </span>
          <span className={priorityBadgeClasses(c.priority)}>
            {humanize(c.priority)}
          </span>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          <span className="font-mono">{c.clientPartyId}</span> · language{" "}
          {c.language} · created {formatDateTime(c.createdAt)} · updated{" "}
          {formatDateTime(c.updatedAt)}
        </p>
        {(c.refusalReason || c.escalationReason) && (
          <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
            {c.refusalReason ?? c.escalationReason}
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="card-source">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="w-4 h-4 text-primary" aria-hidden="true" />{" "}
              Source
              {sources[0]?.filename ? (
                <span className="font-normal text-sm text-muted-foreground">
                  {sources[0].filename}
                </span>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sourceText ? (
              <SourcePane text={sourceText} />
            ) : (
              <p className="text-sm text-muted-foreground">
                No text content for this source.
              </p>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-candidates">
          <CardHeader>
            <CardTitle className="text-base">Field candidates</CardTitle>
          </CardHeader>
          <CardContent>
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Extraction proposed no candidates for this source.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Field</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Review</TableHead>
                    {reviewable && (
                      <TableHead className="sr-only">Actions</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {candidates.map((candidate) => (
                    <CandidateRow
                      key={candidate.id}
                      candidate={candidate}
                      reviewable={reviewable}
                      staged={staged[candidate.id]}
                      onStage={stage}
                      onUnstage={unstage}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {reviewable && (
        <Card data-testid="card-decision-bar">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-56 space-y-1.5">
                <Label htmlFor="reason-code">Reason code</Label>
                <Input
                  id="reason-code"
                  value={reasonCode}
                  onChange={(e) => setReasonCode(e.target.value)}
                  placeholder="e.g. fields_verified"
                  data-testid="input-reason-code"
                />
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => submitDecision("approve")}
                  disabled={review.isPending || reasonCode.trim().length < 2}
                  data-testid="button-approve"
                >
                  {pendingDecision === "approve" ? "Approving…" : "Approve"}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => submitDecision("reject")}
                  disabled={review.isPending || reasonCode.trim().length < 2}
                  data-testid="button-reject"
                >
                  {pendingDecision === "reject" ? "Rejecting…" : "Reject"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => submitDecision("escalate")}
                  disabled={review.isPending || reasonCode.trim().length < 2}
                  data-testid="button-escalate"
                >
                  {pendingDecision === "escalate" ? "Escalating…" : "Escalate"}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              {stagedCount > 0
                ? `${stagedCount} staged field action${stagedCount === 1 ? "" : "s"} will be recorded with the decision. `
                : ""}
              Critical fields must be confirmed (or edited) before approval.
            </p>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card data-testid="card-decisions">
          <CardHeader>
            <CardTitle className="text-base">Review decisions</CardTitle>
          </CardHeader>
          <CardContent>
            {decisions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No decisions yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Actor</TableHead>
                    <TableHead>Decision</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {decisions.map((d) => (
                    <TableRow key={d.id} data-testid={`row-decision-${d.id}`}>
                      <TableCell
                        className="font-mono text-xs"
                        title={d.actorUserId}
                      >
                        {d.actorUserId.slice(0, 8)}…{" "}
                        <span className="font-sans text-muted-foreground">
                          ({humanize(d.actorRole)})
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={pillClasses(
                            d.decision === "approve"
                              ? "emerald"
                              : d.decision === "reject"
                                ? "red"
                                : d.decision === "escalate"
                                  ? "amber"
                                  : "blue",
                          )}
                        >
                          {humanize(d.decision)}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {d.reasonCode}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {formatDateTime(d.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card data-testid="card-runs">
          <CardHeader>
            <CardTitle className="text-base">Inference runs</CardTitle>
          </CardHeader>
          <CardContent>
            {runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No inference runs recorded.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Latency</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((r) => (
                    <TableRow key={r.id} data-testid={`row-run-${r.id}`}>
                      <TableCell>{humanize(r.purpose)}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.model}
                      </TableCell>
                      <TableCell>
                        <span className={clerkRunOutcomeBadgeClasses(r.outcome)}>
                          {humanize(r.outcome)}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground tabular-nums">
                        {r.latencyMs} ms
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
