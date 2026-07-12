import { useMemo, useState } from "react";
import {
  useGetMe,
  useListClaims,
  useCreateClaim,
  useUpdateClaim,
  useSubmitClaim,
  useDecideClaim,
  getListClaimsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClaimRecord,
  ProtectedFact,
  ProtectedFactKind,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { errorStatus } from "@/lib/errors";
import { formatDate, pillClasses, type BadgeTone } from "@/lib/format";
import { BookMarked, Plus, Trash2 } from "lucide-react";

// Clerk v0: the claims register is the ONLY source the AI clerk may answer
// from. Every claim moves draft -> review -> active under maker-checker (the
// author can never approve their own version — the server enforces it, the UI
// explains it). Protected facts are stored verbatim and rendered verbatim.

const STATE_TONE: Record<string, BadgeTone> = {
  draft: "slate",
  review: "amber",
  active: "emerald",
  suspended: "red",
  superseded: "slate",
  expired: "slate",
  rejected: "red",
};

const STATE_ORDER: Record<string, number> = {
  review: 0,
  draft: 1,
  active: 2,
  suspended: 3,
  rejected: 4,
  superseded: 5,
  expired: 6,
};

const FACT_KINDS: ProtectedFactKind[] = [
  "rate",
  "amount",
  "duration",
  "date",
  "count",
  "text",
];

interface ClaimForm {
  claimKey: string;
  title: string;
  proposition: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo: string;
  facts: ProtectedFact[];
}

const EMPTY_FORM: ClaimForm = {
  claimKey: "",
  title: "",
  proposition: "",
  citation: "",
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: "",
  facts: [{ key: "", label: "", kind: "rate", value: "", unit: "" }],
};

function formFromClaim(claim: ClaimRecord): ClaimForm {
  return {
    claimKey: claim.claimKey,
    title: claim.title,
    proposition: claim.proposition,
    citation: claim.citation,
    effectiveFrom: claim.effectiveFrom.slice(0, 10),
    effectiveTo: claim.effectiveTo ? claim.effectiveTo.slice(0, 10) : "",
    facts: claim.protectedFacts.map((f) => ({ ...f, unit: f.unit ?? "" })),
  };
}

function FactsEditor({
  facts,
  onChange,
}: {
  facts: ProtectedFact[];
  onChange: (facts: ProtectedFact[]) => void;
}) {
  const set = (i: number, patch: Partial<ProtectedFact>) =>
    onChange(facts.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  return (
    <div className="space-y-2">
      {facts.map((fact, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-2">
            <Input
              placeholder="key"
              value={fact.key}
              onChange={(e) => set(i, { key: e.target.value })}
              data-testid={`input-fact-key-${i}`}
            />
          </div>
          <div className="col-span-3">
            <Input
              placeholder="Label"
              value={fact.label}
              onChange={(e) => set(i, { label: e.target.value })}
              data-testid={`input-fact-label-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Select
              value={fact.kind}
              onValueChange={(v) => set(i, { kind: v as ProtectedFactKind })}
            >
              <SelectTrigger data-testid={`select-fact-kind-${i}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FACT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {k}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <Input
              placeholder="Value"
              value={fact.value}
              onChange={(e) => set(i, { value: e.target.value })}
              data-testid={`input-fact-value-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Input
              placeholder="Unit"
              value={fact.unit ?? ""}
              onChange={(e) => set(i, { unit: e.target.value })}
              data-testid={`input-fact-unit-${i}`}
            />
          </div>
          <div className="col-span-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(facts.filter((_, j) => j !== i))}
              disabled={facts.length === 1}
              data-testid={`button-remove-fact-${i}`}
            >
              <Trash2 className="w-4 h-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() =>
          onChange([
            ...facts,
            { key: "", label: "", kind: "text", value: "", unit: "" },
          ])
        }
        data-testid="button-add-fact"
      >
        <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add fact
      </Button>
    </div>
  );
}

export function ClaimsRegister() {
  usePageTitle("Claims register");
  const { data: me } = useGetMe();
  const caps = new Set(me?.capabilities ?? []);
  const canWrite = caps.has("claims.write");
  const canApprove = caps.has("claims.approve");

  const { data: claims, isLoading, error, refetch } = useListClaims();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListClaimsQueryKey() });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ClaimRecord | null>(null);
  const [form, setForm] = useState<ClaimForm>(EMPTY_FORM);
  const [detail, setDetail] = useState<ClaimRecord | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const onError = (err: unknown, fallback: string) => {
    const status = errorStatus(err);
    const message =
      err && typeof err === "object" && "body" in err
        ? String(
            (err as { body?: { error?: string } }).body?.error ?? fallback,
          )
        : fallback;
    toast({
      title: status === 403 ? "Not allowed" : "Something went wrong",
      description: message,
      variant: "destructive",
    });
  };

  const createClaim = useCreateClaim({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditorOpen(false);
        toast({ title: "Draft claim created" });
      },
      onError: (e) => onError(e, "Could not create the claim."),
    },
  });
  const updateClaim = useUpdateClaim({
    mutation: {
      onSuccess: () => {
        invalidate();
        setEditorOpen(false);
        toast({ title: "Draft updated" });
      },
      onError: (e) => onError(e, "Could not update the claim."),
    },
  });
  const submitClaim = useSubmitClaim({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDetail(null);
        toast({
          title: "Submitted for review",
          description: "A second operator must approve it before it goes live.",
        });
      },
      onError: (e) => onError(e, "Could not submit the claim."),
    },
  });
  const decideClaim = useDecideClaim({
    mutation: {
      onSuccess: (updated) => {
        invalidate();
        setDetail(null);
        setDecisionNote("");
        toast({ title: `Claim ${updated.state}` });
      },
      onError: (e) =>
        onError(
          e,
          "Could not record the decision. The author of a version cannot approve it.",
        ),
    },
  });

  const sorted = useMemo(
    () =>
      [...(claims ?? [])].sort(
        (a, b) =>
          (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
          a.claimKey.localeCompare(b.claimKey) ||
          b.version - a.version,
      ),
    [claims],
  );

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditorOpen(true);
  };
  const openEdit = (claim: ClaimRecord) => {
    setEditing(claim);
    setForm(formFromClaim(claim));
    setEditorOpen(true);
  };

  const saveDisabled =
    !form.claimKey.trim() ||
    !form.title.trim() ||
    form.proposition.trim().length < 10 ||
    !form.citation.trim() ||
    !form.effectiveFrom ||
    form.facts.some((f) => !f.key.trim() || !f.label.trim() || !f.value.trim());

  const save = () => {
    const payload = {
      claimKey: form.claimKey.trim(),
      title: form.title.trim(),
      proposition: form.proposition.trim(),
      citation: form.citation.trim(),
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      protectedFacts: form.facts.map((f) => ({
        ...f,
        unit: f.unit?.trim() ? f.unit.trim() : undefined,
      })),
    };
    if (editing) {
      const { claimKey: _ignored, ...update } = payload;
      updateClaim.mutate({ id: editing.id, data: update });
    } else {
      createClaim.mutate({ data: payload });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error) return <QueryError thing="the claims register" onRetry={refetch} />;

  const isMakerOfDetail = detail != null && me?.userId === detail.submittedBy;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BookMarked className="w-6 h-6" aria-hidden="true" /> Claims
            register
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            The approved facts the Clerk is allowed to answer from. Nothing
            reaches a client unless it is active here.
          </p>
        </div>
        {canWrite && (
          <Button onClick={openCreate} data-testid="button-new-claim">
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New draft claim
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No claims yet. Create a draft to get started.
            </p>
          ) : (
            <div className="divide-y">
              {sorted.map((claim) => (
                <button
                  key={claim.id}
                  type="button"
                  onClick={() => {
                    setDetail(claim);
                    setDecisionNote("");
                  }}
                  className="w-full text-left flex items-center gap-3 py-3 -mx-2 px-2 rounded-md hover:bg-muted/50"
                  data-testid={`row-claim-${claim.claimKey}-v${claim.version}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">
                      {claim.title}{" "}
                      <span className="text-xs text-muted-foreground font-normal">
                        v{claim.version}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      <code>{claim.claimKey}</code> · {claim.citation} ·
                      effective {formatDate(claim.effectiveFrom)}
                    </p>
                  </div>
                  <span className={pillClasses(STATE_TONE[claim.state] ?? "slate")}>
                    {claim.state}
                  </span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Claim detail + decision */}
      <Dialog open={detail != null} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-2xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  {detail.title}
                  <span className={pillClasses(STATE_TONE[detail.state] ?? "slate")}>
                    {detail.state}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  <code>{detail.claimKey}</code> · version {detail.version}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 text-sm">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                    Proposition (rendered verbatim to users)
                  </p>
                  <p className="border rounded-md p-3 bg-muted/40">
                    {detail.proposition}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
                    Protected facts
                  </p>
                  <div className="border rounded-md divide-y">
                    {detail.protectedFacts.map((f) => (
                      <div
                        key={f.key}
                        className="flex items-center gap-2 px-3 py-2"
                      >
                        <span className="flex-1">{f.label}</span>
                        <code className="text-xs text-muted-foreground">
                          {f.kind}
                        </code>
                        <span className="font-medium tabular-nums">
                          {f.value}
                          {f.unit ? ` ${f.unit}` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Citation: {detail.citation} · Effective{" "}
                  {formatDate(detail.effectiveFrom)}
                  {detail.effectiveTo
                    ? ` to ${formatDate(detail.effectiveTo)}`
                    : ""}
                  {detail.decisionNote ? ` · Note: ${detail.decisionNote}` : ""}
                </p>
                {detail.state === "review" && canApprove && (
                  <div className="space-y-2 border-t pt-3">
                    {isMakerOfDetail && (
                      <p className="text-xs text-amber-700 dark:text-amber-400">
                        You submitted this version, so a different operator
                        must approve it (maker-checker).
                      </p>
                    )}
                    <Label htmlFor="decision-note">Decision note</Label>
                    <Textarea
                      id="decision-note"
                      value={decisionNote}
                      onChange={(e) => setDecisionNote(e.target.value)}
                      placeholder="What did you check it against?"
                      data-testid="input-decision-note"
                    />
                  </div>
                )}
              </div>
              <DialogFooter className="gap-2 flex-wrap">
                {detail.state === "draft" && canWrite && (
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setDetail(null);
                        openEdit(detail);
                      }}
                      data-testid="button-edit-claim"
                    >
                      Edit draft
                    </Button>
                    <Button
                      onClick={() => submitClaim.mutate({ id: detail.id })}
                      disabled={submitClaim.isPending}
                      data-testid="button-submit-claim"
                    >
                      Submit for review
                    </Button>
                  </>
                )}
                {detail.state === "review" && canApprove && (
                  <>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        decideClaim.mutate({
                          id: detail.id,
                          data: {
                            action: "reject",
                            note: decisionNote || null,
                          },
                        })
                      }
                      disabled={decideClaim.isPending}
                      data-testid="button-reject-claim"
                    >
                      Reject
                    </Button>
                    <Button
                      onClick={() =>
                        decideClaim.mutate({
                          id: detail.id,
                          data: {
                            action: "approve",
                            note: decisionNote || null,
                          },
                        })
                      }
                      disabled={decideClaim.isPending || isMakerOfDetail}
                      data-testid="button-approve-claim"
                    >
                      Approve
                    </Button>
                  </>
                )}
                {detail.state === "active" && canApprove && (
                  <Button
                    variant="destructive"
                    onClick={() =>
                      decideClaim.mutate({
                        id: detail.id,
                        data: { action: "suspend", note: decisionNote || null },
                      })
                    }
                    disabled={decideClaim.isPending}
                    data-testid="button-suspend-claim"
                  >
                    Suspend
                  </Button>
                )}
                {detail.state === "suspended" && canApprove && (
                  <Button
                    onClick={() =>
                      decideClaim.mutate({
                        id: detail.id,
                        data: { action: "resume", note: decisionNote || null },
                      })
                    }
                    disabled={decideClaim.isPending}
                    data-testid="button-resume-claim"
                  >
                    Resume
                  </Button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Create / edit draft */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit draft claim" : "New draft claim"}
            </DialogTitle>
            <DialogDescription>
              Drafts are invisible to the Clerk until a second operator
              approves them.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="claim-key">Claim key</Label>
                <Input
                  id="claim-key"
                  placeholder="vat.standard_rate"
                  value={form.claimKey}
                  disabled={editing != null}
                  onChange={(e) =>
                    setForm({ ...form, claimKey: e.target.value })
                  }
                  data-testid="input-claim-key"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="claim-title">Title</Label>
                <Input
                  id="claim-title"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  data-testid="input-claim-title"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="claim-proposition">
                Proposition — use {"{key}"} placeholders for protected facts
              </Label>
              <Textarea
                id="claim-proposition"
                value={form.proposition}
                onChange={(e) =>
                  setForm({ ...form, proposition: e.target.value })
                }
                placeholder="The standard VAT rate on taxable supplies is {rate}."
                data-testid="input-claim-proposition"
              />
            </div>
            <div className="space-y-1">
              <Label>Protected facts</Label>
              <FactsEditor
                facts={form.facts}
                onChange={(facts) => setForm({ ...form, facts })}
              />
            </div>
            <div className="grid sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label htmlFor="claim-citation">Citation</Label>
                <Input
                  id="claim-citation"
                  placeholder="VAT Act, s.4"
                  value={form.citation}
                  onChange={(e) =>
                    setForm({ ...form, citation: e.target.value })
                  }
                  data-testid="input-claim-citation"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="claim-from">Effective from</Label>
                <Input
                  id="claim-from"
                  type="date"
                  value={form.effectiveFrom}
                  onChange={(e) =>
                    setForm({ ...form, effectiveFrom: e.target.value })
                  }
                  data-testid="input-claim-from"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="claim-to">Effective to (optional)</Label>
                <Input
                  id="claim-to"
                  type="date"
                  value={form.effectiveTo}
                  onChange={(e) =>
                    setForm({ ...form, effectiveTo: e.target.value })
                  }
                  data-testid="input-claim-to"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setEditorOpen(false)}
              data-testid="button-cancel-claim"
            >
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={
                saveDisabled || createClaim.isPending || updateClaim.isPending
              }
              data-testid="button-save-claim"
            >
              {editing ? "Save draft" : "Create draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
