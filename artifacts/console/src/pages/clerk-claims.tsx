import { useState } from "react";
import {
  useGetMe,
  useListClaimRecords,
  useCreateClaimRecord,
  useSubmitClaimRecord,
  useApproveClaimRecord,
  useRejectClaimRecord,
  useSuspendClaimRecord,
  useListClerkKillSwitches,
  useSetClerkKillSwitch,
  getListClaimRecordsQueryKey,
  getListClerkKillSwitchesQueryKey,
} from "@workspace/api-client-react";
import type {
  ClaimRecord,
  ClaimProtectedFactKind,
  ClerkKillSwitch,
} from "@workspace/api-client-react";
import { ClaimProtectedFactKind as FactKind } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { isFeatureDisabled, serverErrorMessage } from "@/lib/errors";
import {
  claimStatusBadgeClasses,
  formatDate,
  humanize,
} from "@/lib/format";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Plus,
  Power,
  Scale,
  Trash2,
} from "lucide-react";

// The claims register (CLK-KB-01..04): versioned legal propositions with
// protected facts that Clerk may quote verbatim — and only these. Maker-checker
// is server-enforced (the author cannot approve their own draft; the API
// answers 409). Kill switches (CLK-AI-11) live here too: the operator's
// platform-wide stop for each Clerk capability.

interface FactRow {
  key: string;
  kind: ClaimProtectedFactKind;
  value: string;
  unit: string;
}

const EMPTY_FACT: FactRow = { key: "", kind: "amount", value: "", unit: "" };

interface DraftForm {
  claimKey: string;
  proposition: string;
  legalInstrument: string;
  legalSection: string;
  effectiveFrom: string;
  reviewDueAt: string;
  clerkQuotable: boolean;
  facts: FactRow[];
}

const EMPTY_DRAFT: DraftForm = {
  claimKey: "",
  proposition: "",
  legalInstrument: "",
  legalSection: "",
  effectiveFrom: "",
  reviewDueAt: "",
  clerkQuotable: true,
  facts: [{ ...EMPTY_FACT }],
};

type RowAction = {
  mode: "approve" | "reject" | "suspend";
  claim: ClaimRecord;
};

function KillSwitchRow({
  killSwitch,
  canKill,
  saving,
  onSet,
}: {
  killSwitch: ClerkKillSwitch;
  canKill: boolean;
  saving: boolean;
  onSet: (capability: string, disabled: boolean, reason?: string) => void;
}) {
  const [reason, setReason] = useState("");
  const s = killSwitch;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 py-3"
      data-testid={`kill-switch-${s.capability}`}
    >
      <div className="min-w-0">
        <p className="font-medium text-sm flex items-center gap-2">
          {humanize(s.capability)}
          {s.disabled && (
            <span className="text-xs font-normal text-destructive border border-destructive/40 rounded-full px-2 py-0.5">
              Blocked
            </span>
          )}
        </p>
        {s.disabled && s.reason && (
          <p className="text-xs text-muted-foreground mt-0.5">“{s.reason}”</p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5">
          Changed {formatDate(s.changedAt)}
          {s.changedBy ? ` · by ${s.changedBy.slice(0, 8)}…` : ""}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {canKill && !s.disabled && (
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (required to block)"
            className="h-8 w-56"
            aria-label={`Reason for blocking ${s.capability}`}
            data-testid={`input-kill-reason-${s.capability}`}
          />
        )}
        <Switch
          checked={s.disabled}
          disabled={!canKill || saving || (!s.disabled && !reason.trim())}
          onCheckedChange={(checked) =>
            onSet(s.capability, checked, checked ? reason.trim() : undefined)
          }
          className="data-[state=checked]:bg-destructive"
          aria-label={`Block ${s.capability}`}
          data-testid={`switch-kill-${s.capability}`}
        />
      </div>
    </div>
  );
}

export function ClerkClaims() {
  usePageTitle("Claims register");
  const { data: me } = useGetMe();
  const caps = new Set(me?.capabilities ?? []);
  const canWrite = caps.has("claims.write");
  const canApprove = caps.has("claims.approve");
  const canKill = caps.has("clerk.kill");

  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: claims, isLoading, error, refetch } = useListClaimRecords();
  const {
    data: killSwitches,
    error: killError,
    refetch: refetchKill,
  } = useListClerkKillSwitches();

  const create = useCreateClaimRecord();
  const submit = useSubmitClaimRecord();
  const approve = useApproveClaimRecord();
  const reject = useRejectClaimRecord();
  const suspend = useSuspendClaimRecord();
  const setKill = useSetClerkKillSwitch();

  const [featureDark, setFeatureDark] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<DraftForm>(EMPTY_DRAFT);
  const [rowAction, setRowAction] = useState<RowAction | null>(null);
  const [actionReason, setActionReason] = useState("");
  const [pendingClaimId, setPendingClaimId] = useState<string | null>(null);
  const [savingCapability, setSavingCapability] = useState<string | null>(null);

  const invalidateClaims = () =>
    queryClient.invalidateQueries({ queryKey: getListClaimRecordsQueryKey() });

  const mutationError = (title: string) => (err: unknown) => {
    if (isFeatureDisabled(err)) {
      setFeatureDark(true);
      return;
    }
    // Surfaces the maker-checker 409 ("author cannot approve") verbatim.
    toast({
      title,
      description: serverErrorMessage(err),
      variant: "destructive",
    });
  };

  const draftValid =
    draft.claimKey.trim().length >= 3 &&
    draft.proposition.trim().length >= 10 &&
    draft.legalInstrument.trim().length >= 2 &&
    draft.legalSection.trim().length >= 1 &&
    !!draft.effectiveFrom &&
    !!draft.reviewDueAt;

  const handleCreate = () => {
    if (!draftValid) return;
    const protectedFacts = draft.facts
      .filter((f) => f.key.trim() && f.value.trim())
      .map((f) => ({
        key: f.key.trim(),
        kind: f.kind,
        value: f.value.trim(),
        unit: f.unit.trim() || undefined,
      }));
    create.mutate(
      {
        data: {
          claimKey: draft.claimKey.trim(),
          proposition: draft.proposition.trim(),
          legalInstrument: draft.legalInstrument.trim(),
          legalSection: draft.legalSection.trim(),
          effectiveFrom: draft.effectiveFrom,
          reviewDueAt: draft.reviewDueAt,
          clerkQuotable: draft.clerkQuotable,
          protectedFacts: protectedFacts.length > 0 ? protectedFacts : undefined,
        },
      },
      {
        onSuccess: (row) => {
          toast({ title: `Draft ${row.claimKey} v${row.version} created` });
          setDraft(EMPTY_DRAFT);
          setFormOpen(false);
          invalidateClaims();
        },
        onError: mutationError("Could not create the draft"),
      },
    );
  };

  const handleSubmitForReview = (claim: ClaimRecord) => {
    setPendingClaimId(claim.id);
    submit.mutate(
      { id: claim.id },
      {
        onSuccess: () => {
          toast({ title: `${claim.claimKey} submitted for review` });
          invalidateClaims();
        },
        onError: mutationError("Could not submit for review"),
        onSettled: () => setPendingClaimId(null),
      },
    );
  };

  const runRowAction = () => {
    if (!rowAction) return;
    const { mode, claim } = rowAction;
    const reason = actionReason.trim();
    if ((mode === "reject" || mode === "suspend") && reason.length < 3) return;
    setPendingClaimId(claim.id);
    const done = {
      onSuccess: () => {
        toast({
          title: `${claim.claimKey} ${
            mode === "approve"
              ? "approved — now active"
              : mode === "reject"
                ? "rejected"
                : "suspended"
          }`,
        });
        invalidateClaims();
      },
      onError: mutationError(`Could not ${mode} ${claim.claimKey}`),
      onSettled: () => setPendingClaimId(null),
    };
    if (mode === "approve") {
      approve.mutate(
        {
          id: claim.id,
          data: reason ? { approvalEvidence: reason } : undefined,
        },
        done,
      );
    } else if (mode === "reject") {
      reject.mutate({ id: claim.id, data: { reason } }, done);
    } else {
      suspend.mutate({ id: claim.id, data: { reason } }, done);
    }
    setRowAction(null);
    setActionReason("");
  };

  const handleSetKill = (
    capability: string,
    disabled: boolean,
    reason?: string,
  ) => {
    setSavingCapability(capability);
    setKill.mutate(
      { capability, data: { disabled, reason } },
      {
        onSuccess: () => {
          toast({
            title: `${humanize(capability)} ${disabled ? "blocked" : "re-enabled"}`,
            description: disabled
              ? "The capability is stopped platform-wide, effective immediately."
              : "The capability is live again.",
            variant: disabled ? "destructive" : undefined,
          });
          queryClient.invalidateQueries({
            queryKey: getListClerkKillSwitchesQueryKey(),
          });
        },
        onError: mutationError(`Could not update ${capability}`),
        onSettled: () => setSavingCapability(null),
      },
    );
  };

  if (featureDark || isFeatureDisabled(error)) {
    return (
      <div className="space-y-6">
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Claims register
        </h1>
        <FeatureUnavailable feature="Clerk" />
      </div>
    );
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const actionPending =
    submit.isPending || approve.isPending || reject.isPending || suspend.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Claims register
          </h1>
          <p className="text-muted-foreground mt-1">
            Versioned legal propositions with protected facts — the only thing
            Clerk is ever allowed to quote.
          </p>
        </div>
        {canWrite && (
          <Button
            variant={formOpen ? "secondary" : "default"}
            onClick={() => setFormOpen((o) => !o)}
            data-testid="button-toggle-new-claim"
          >
            {formOpen ? (
              <ChevronUp className="w-4 h-4 mr-1" aria-hidden="true" />
            ) : (
              <Plus className="w-4 h-4 mr-1" aria-hidden="true" />
            )}
            New claim draft
          </Button>
        )}
      </div>

      {canWrite && formOpen && (
        <Card data-testid="card-new-claim">
          <CardHeader>
            <CardTitle className="text-base">New claim draft</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="claim-key">Claim key</Label>
                <Input
                  id="claim-key"
                  value={draft.claimKey}
                  onChange={(e) =>
                    setDraft({ ...draft, claimKey: e.target.value })
                  }
                  placeholder="vat.standard_rate"
                  data-testid="input-claim-key"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-instrument">Legal instrument</Label>
                <Input
                  id="claim-instrument"
                  value={draft.legalInstrument}
                  onChange={(e) =>
                    setDraft({ ...draft, legalInstrument: e.target.value })
                  }
                  placeholder="VAT Act"
                  data-testid="input-legal-instrument"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="claim-proposition">Proposition</Label>
              <Textarea
                id="claim-proposition"
                value={draft.proposition}
                onChange={(e) =>
                  setDraft({ ...draft, proposition: e.target.value })
                }
                placeholder="The standard VAT rate is {rate}."
                data-testid="input-proposition"
              />
              <p className="text-xs text-muted-foreground">
                Reference protected facts as {"{key}"} placeholders — Clerk
                substitutes them verbatim, never generates them.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="claim-section">Legal section</Label>
                <Input
                  id="claim-section"
                  value={draft.legalSection}
                  onChange={(e) =>
                    setDraft({ ...draft, legalSection: e.target.value })
                  }
                  placeholder="s. 4(1)"
                  data-testid="input-legal-section"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-effective-from">Effective from</Label>
                <Input
                  id="claim-effective-from"
                  type="date"
                  value={draft.effectiveFrom}
                  onChange={(e) =>
                    setDraft({ ...draft, effectiveFrom: e.target.value })
                  }
                  data-testid="input-effective-from"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claim-review-due">Review due</Label>
                <Input
                  id="claim-review-due"
                  type="date"
                  value={draft.reviewDueAt}
                  onChange={(e) =>
                    setDraft({ ...draft, reviewDueAt: e.target.value })
                  }
                  data-testid="input-review-due"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label>Protected facts</Label>
              {draft.facts.map((fact, i) => (
                <div
                  key={i}
                  className="flex flex-wrap items-center gap-2"
                  data-testid={`fact-row-${i}`}
                >
                  <Input
                    value={fact.key}
                    onChange={(e) => {
                      const facts = [...draft.facts];
                      facts[i] = { ...fact, key: e.target.value };
                      setDraft({ ...draft, facts });
                    }}
                    placeholder="key (e.g. rate)"
                    className="w-36"
                    aria-label={`Fact ${i + 1} key`}
                    data-testid={`input-fact-key-${i}`}
                  />
                  <Select
                    value={fact.kind}
                    onValueChange={(v) => {
                      const facts = [...draft.facts];
                      facts[i] = { ...fact, kind: v as ClaimProtectedFactKind };
                      setDraft({ ...draft, facts });
                    }}
                  >
                    <SelectTrigger
                      className="w-32"
                      aria-label={`Fact ${i + 1} kind`}
                      data-testid={`select-fact-kind-${i}`}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.values(FactKind).map((k) => (
                        <SelectItem key={k} value={k}>
                          {humanize(k)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={fact.value}
                    onChange={(e) => {
                      const facts = [...draft.facts];
                      facts[i] = { ...fact, value: e.target.value };
                      setDraft({ ...draft, facts });
                    }}
                    placeholder="value"
                    className="w-32 flex-1 min-w-24"
                    aria-label={`Fact ${i + 1} value`}
                    data-testid={`input-fact-value-${i}`}
                  />
                  <Input
                    value={fact.unit}
                    onChange={(e) => {
                      const facts = [...draft.facts];
                      facts[i] = { ...fact, unit: e.target.value };
                      setDraft({ ...draft, facts });
                    }}
                    placeholder="unit"
                    className="w-24"
                    aria-label={`Fact ${i + 1} unit`}
                    data-testid={`input-fact-unit-${i}`}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        facts: draft.facts.filter((_, j) => j !== i),
                      })
                    }
                    aria-label={`Remove fact ${i + 1}`}
                    data-testid={`button-remove-fact-${i}`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft({ ...draft, facts: [...draft.facts, { ...EMPTY_FACT }] })
                }
                data-testid="button-add-fact"
              >
                <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add fact
              </Button>
            </div>

            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={draft.clerkQuotable}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, clerkQuotable: v })
                }
                data-testid="switch-clerk-quotable"
              />
              Clerk-quotable — Clerk may answer questions from this claim once
              active
            </label>

            <Button
              onClick={handleCreate}
              disabled={create.isPending || !draftValid}
              data-testid="button-create-claim"
            >
              {create.isPending ? "Creating…" : "Create draft"}
            </Button>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14" />
          ))}
        </div>
      ) : error ? (
        <QueryError thing="the claims register" onRetry={() => refetch()} />
      ) : (claims ?? []).length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <Scale
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-empty">
              No claims yet
            </p>
            <p className="text-sm text-muted-foreground">
              Draft the first legal proposition — it goes live only after a
              second person approves it (maker-checker).
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid="card-claims">
          <CardContent className="pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Claim</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Proposition</TableHead>
                  <TableHead>Citation</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Review due</TableHead>
                  <TableHead>Quotable</TableHead>
                  <TableHead className="sr-only">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(claims ?? []).map((c) => {
                  const overdue =
                    c.reviewDueAt < todayIso &&
                    (c.status === "active" || c.status === "review");
                  const pending = actionPending && pendingClaimId === c.id;
                  return (
                    <TableRow key={c.id} data-testid={`row-claim-${c.id}`}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {c.claimKey}{" "}
                        <span className="text-muted-foreground">
                          v{c.version}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className={claimStatusBadgeClasses(c.status)}>
                          {humanize(c.status)}
                        </span>
                      </TableCell>
                      <TableCell
                        className="max-w-56 truncate text-muted-foreground"
                        title={c.proposition}
                      >
                        {c.proposition}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {c.legalInstrument} {c.legalSection}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(c.effectiveFrom)} →{" "}
                        {c.effectiveTo ? formatDate(c.effectiveTo) : "open"}
                      </TableCell>
                      <TableCell
                        className={`whitespace-nowrap text-xs ${
                          overdue
                            ? "text-red-600 dark:text-red-400 font-medium"
                            : "text-muted-foreground"
                        }`}
                        data-testid={`review-due-${c.id}`}
                      >
                        {formatDate(c.reviewDueAt)}
                        {overdue ? " (overdue)" : ""}
                      </TableCell>
                      <TableCell>
                        {c.clerkQuotable ? (
                          <Check
                            className="w-4 h-4 text-emerald-600 dark:text-emerald-400"
                            aria-label="Clerk-quotable"
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {c.status === "draft" && canWrite && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pending}
                            onClick={() => handleSubmitForReview(c)}
                            data-testid={`button-submit-${c.id}`}
                          >
                            {pending ? "Submitting…" : "Submit for review"}
                          </Button>
                        )}
                        {c.status === "review" && canApprove && (
                          <div className="flex justify-end gap-1.5">
                            <Button
                              size="sm"
                              disabled={pending}
                              onClick={() =>
                                setRowAction({ mode: "approve", claim: c })
                              }
                              data-testid={`button-approve-${c.id}`}
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={pending}
                              onClick={() =>
                                setRowAction({ mode: "reject", claim: c })
                              }
                              data-testid={`button-reject-${c.id}`}
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                        {c.status === "active" && canApprove && (
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={pending}
                            onClick={() =>
                              setRowAction({ mode: "suspend", claim: c })
                            }
                            data-testid={`button-suspend-${c.id}`}
                          >
                            Suspend
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card data-testid="card-kill-switches">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Power className="w-4 h-4 text-destructive" aria-hidden="true" />{" "}
            Kill switches
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-2">
            Flipping a switch immediately blocks that capability platform-wide
            (CLK-AI-11).
          </p>
          {killError && !isFeatureDisabled(killError) ? (
            <QueryError thing="kill switches" onRetry={() => refetchKill()} />
          ) : (
            <div className="divide-y">
              {(killSwitches ?? []).map((s) => (
                <KillSwitchRow
                  key={s.capability}
                  killSwitch={s}
                  canKill={canKill}
                  saving={setKill.isPending && savingCapability === s.capability}
                  onSet={handleSetKill}
                />
              ))}
              {(killSwitches ?? []).length === 0 && !killError && (
                <p className="text-sm text-muted-foreground py-2">
                  No kill switches registered yet.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={rowAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRowAction(null);
            setActionReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {rowAction?.mode === "approve"
                ? `Approve ${rowAction.claim.claimKey} v${rowAction.claim.version}`
                : rowAction?.mode === "reject"
                  ? `Reject ${rowAction.claim.claimKey} v${rowAction.claim.version}`
                  : `Suspend ${rowAction?.claim.claimKey} v${rowAction?.claim.version}`}
            </DialogTitle>
            <DialogDescription>
              {rowAction?.mode === "approve"
                ? "Approval activates the claim — Clerk can quote it immediately. The author cannot approve their own draft (maker-checker)."
                : rowAction?.mode === "reject"
                  ? "Rejection sends the draft back with a reason on the record."
                  : "Suspension pulls the claim out of Clerk's answers immediately."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="claim-action-reason">
              {rowAction?.mode === "approve"
                ? "Approval evidence (optional)"
                : "Reason (required)"}
            </Label>
            <Textarea
              id="claim-action-reason"
              value={actionReason}
              onChange={(e) => setActionReason(e.target.value)}
              placeholder={
                rowAction?.mode === "approve"
                  ? "e.g. checked against the gazetted instrument"
                  : "Why this claim cannot stand"
              }
              data-testid="input-action-reason"
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setRowAction(null);
                setActionReason("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant={rowAction?.mode === "approve" ? "default" : "destructive"}
              onClick={runRowAction}
              disabled={
                rowAction?.mode !== "approve" && actionReason.trim().length < 3
              }
              data-testid="button-confirm-action"
            >
              {rowAction?.mode === "approve"
                ? "Approve claim"
                : rowAction?.mode === "reject"
                  ? "Reject claim"
                  : "Suspend claim"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
