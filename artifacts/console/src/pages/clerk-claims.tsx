import { Fragment, useMemo, useState } from "react";
import {
  useListClaims,
  useCreateClaim,
  useUpdateClaim,
  useSubmitClaim,
  useDecideClaim,
  getListClaimsQueryKey,
} from "@workspace/api-client-react";
import type {
  ClaimRecord,
  ClaimDecisionInputAction,
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  errorStatus,
  killSwitchTripped,
  serverErrorMessage,
} from "@/lib/errors";
import { formatDate, pillClasses, type BadgeTone } from "@/lib/format";
import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  PowerOff,
  Send,
  Trash2,
} from "lucide-react";

// Clerk v0 claims register admin. The register is the ONLY source the Clerk
// may answer from: every claim version walks draft -> review -> active under
// maker-checker (the author of a version can never approve it — the server
// answers 403 CLAIM_SELF_APPROVAL if they try). If the clerk_ai kill switch is
// off the server answers 503 CLERK_DISABLED and this page says so.

const STATE_TONE: Record<string, BadgeTone> = {
  draft: "slate",
  review: "amber",
  active: "emerald",
  suspended: "red",
  superseded: "slate",
  expired: "slate",
  rejected: "slate",
};

const FACT_KINDS: ProtectedFactKind[] = [
  "rate",
  "amount",
  "duration",
  "date",
  "count",
  "text",
];

// "none" is a UI-only sentinel (Radix Select cannot hold an empty value); it
// maps to an empty applicability object on the wire.
const CATEGORIES = ["none", "b2b", "b2g", "b2c"] as const;
type CategoryOption = (typeof CATEGORIES)[number];

interface ClaimForm {
  claimKey: string;
  title: string;
  proposition: string;
  citation: string;
  effectiveFrom: string;
  effectiveTo: string;
  reviewDueAt: string;
  category: CategoryOption;
  facts: ProtectedFact[];
}

const EMPTY_FORM: ClaimForm = {
  claimKey: "",
  title: "",
  proposition: "",
  citation: "",
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: "",
  reviewDueAt: "",
  category: "none",
  facts: [{ key: "", label: "", kind: "rate", value: "", unit: "" }],
};

function formFromClaim(claim: ClaimRecord): ClaimForm {
  const category = claim.applicability?.category;
  return {
    claimKey: claim.claimKey,
    title: claim.title,
    proposition: claim.proposition,
    citation: claim.citation,
    effectiveFrom: claim.effectiveFrom.slice(0, 10),
    effectiveTo: claim.effectiveTo ? claim.effectiveTo.slice(0, 10) : "",
    reviewDueAt: claim.reviewDueAt ? claim.reviewDueAt.slice(0, 10) : "",
    category:
      category === "b2b" || category === "b2g" || category === "b2c"
        ? category
        : "none",
    facts:
      claim.protectedFacts.length > 0
        ? claim.protectedFacts.map((f) => ({ ...f, unit: f.unit ?? "" }))
        : [{ key: "", label: "", kind: "rate", value: "", unit: "" }],
  };
}

function formInvalid(form: ClaimForm): boolean {
  return (
    form.claimKey.trim().length < 3 ||
    form.title.trim().length < 3 ||
    form.proposition.trim().length < 10 ||
    form.citation.trim().length < 3 ||
    !form.effectiveFrom ||
    form.facts.length === 0 ||
    form.facts.some((f) => !f.key.trim() || !f.label.trim() || !f.value.trim())
  );
}

function factsPayload(facts: ProtectedFact[]): ProtectedFact[] {
  return facts.map((f) => ({
    key: f.key.trim(),
    label: f.label.trim(),
    kind: f.kind,
    value: f.value.trim(),
    unit: f.unit?.trim() ? f.unit.trim() : undefined,
  }));
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
        <div key={i} className="grid grid-cols-12 gap-2" data-testid={`row-fact-${i}`}>
          <div className="col-span-2">
            <Input
              placeholder="key"
              value={fact.key}
              onChange={(e) => set(i, { key: e.target.value })}
              aria-label={`Fact ${i + 1} key`}
              data-testid={`input-fact-key-${i}`}
            />
          </div>
          <div className="col-span-3">
            <Input
              placeholder="Label"
              value={fact.label}
              onChange={(e) => set(i, { label: e.target.value })}
              aria-label={`Fact ${i + 1} label`}
              data-testid={`input-fact-label-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Select
              value={fact.kind}
              onValueChange={(v) => set(i, { kind: v as ProtectedFactKind })}
            >
              <SelectTrigger
                aria-label={`Fact ${i + 1} kind`}
                data-testid={`select-fact-kind-${i}`}
              >
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
              aria-label={`Fact ${i + 1} value`}
              data-testid={`input-fact-value-${i}`}
            />
          </div>
          <div className="col-span-2">
            <Input
              placeholder="Unit"
              value={fact.unit ?? ""}
              onChange={(e) => set(i, { unit: e.target.value })}
              aria-label={`Fact ${i + 1} unit`}
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
              aria-label={`Remove fact ${i + 1}`}
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

// The one claim form, shared by the "new version" panel and the draft-edit
// dialog. claimKey is immutable once a draft exists (a new key means a new
// draft, not an edit).
function ClaimFormFields({
  form,
  setForm,
  keyLocked,
}: {
  form: ClaimForm;
  setForm: (form: ClaimForm) => void;
  keyLocked: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="claim-key">Claim key</Label>
          <Input
            id="claim-key"
            placeholder="vat.standard_rate"
            value={form.claimKey}
            disabled={keyLocked}
            onChange={(e) => setForm({ ...form, claimKey: e.target.value })}
            data-testid="input-claim-key"
          />
          <p className="text-xs text-muted-foreground">
            Reuse an existing key to draft the next version of that claim.
          </p>
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
        <Label htmlFor="claim-proposition">Proposition</Label>
        <Textarea
          id="claim-proposition"
          value={form.proposition}
          onChange={(e) => setForm({ ...form, proposition: e.target.value })}
          placeholder="The standard VAT rate on taxable supplies is {rate}."
          data-testid="input-claim-proposition"
        />
        <p className="text-xs text-muted-foreground">
          Reference facts as {"{key}"} placeholders — they are rendered
          verbatim from the protected facts below.
        </p>
      </div>
      <div className="space-y-1">
        <Label>Protected facts</Label>
        <FactsEditor
          facts={form.facts}
          onChange={(facts) => setForm({ ...form, facts })}
        />
      </div>
      <div className="grid sm:grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label htmlFor="claim-citation">Citation</Label>
          <Input
            id="claim-citation"
            placeholder="VAT Act, s.4"
            value={form.citation}
            onChange={(e) => setForm({ ...form, citation: e.target.value })}
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
            onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })}
            data-testid="input-claim-to"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="claim-review-due">Review due (optional)</Label>
          <Input
            id="claim-review-due"
            type="date"
            value={form.reviewDueAt}
            onChange={(e) =>
              setForm({ ...form, reviewDueAt: e.target.value })
            }
            data-testid="input-claim-review-due"
          />
        </div>
        <div className="space-y-1">
          <Label>Category</Label>
          <Select
            value={form.category}
            onValueChange={(v) =>
              setForm({ ...form, category: v as CategoryOption })
            }
          >
            <SelectTrigger
              aria-label="Applicability category"
              data-testid="select-claim-category"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === "none" ? "Any (no category)" : c.toUpperCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

function ClaimDetail({ claim }: { claim: ClaimRecord }) {
  return (
    <div className="space-y-3 text-sm" data-testid={`detail-claim-${claim.id}`}>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
          Proposition (rendered verbatim to users)
        </p>
        <p className="border rounded-md p-3 bg-card">{claim.proposition}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase mb-1">
          Protected facts
        </p>
        <div className="border rounded-md divide-y bg-card">
          {claim.protectedFacts.map((f) => (
            <div key={f.key} className="flex items-center gap-2 px-3 py-2">
              <code className="text-xs w-32 shrink-0">{f.key}</code>
              <span className="flex-1">{f.label}</span>
              <code className="text-xs text-muted-foreground">{f.kind}</code>
              <span className="font-medium tabular-nums">
                {f.value}
                {f.unit ? ` ${f.unit}` : ""}
              </span>
            </div>
          ))}
          {claim.protectedFacts.length === 0 && (
            <p className="px-3 py-2 text-muted-foreground">
              No protected facts on this version.
            </p>
          )}
        </div>
      </div>
      {claim.decisionNote && (
        <p className="text-xs text-muted-foreground">
          Decision note: {claim.decisionNote}
        </p>
      )}
    </div>
  );
}

type DecisionAction = Extract<
  ClaimDecisionInputAction,
  "approve" | "reject" | "suspend"
>;

const DECISION_COPY: Record<
  DecisionAction,
  { title: string; help: string; confirm: string; noteRequired: boolean }
> = {
  approve: {
    title: "Approve",
    help: "Approving activates this version and supersedes any currently active version of the same claim. The author of a version can never approve it — the server enforces this.",
    confirm: "Approve",
    noteRequired: false,
  },
  reject: {
    title: "Reject",
    help: "Rejecting sends this version back to its author. A note explaining why is required.",
    confirm: "Reject",
    noteRequired: true,
  },
  suspend: {
    title: "Suspend",
    help: "Suspending immediately stops the Clerk from quoting this claim. A note explaining why is required.",
    confirm: "Suspend",
    noteRequired: true,
  },
};

export function ClerkClaims() {
  usePageTitle("Claims register");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [disabledBanner, setDisabledBanner] = useState(false);

  const { data: claims, isLoading, error, refetch } = useListClaims();

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<ClaimForm>(EMPTY_FORM);
  const [editing, setEditing] = useState<ClaimRecord | null>(null);
  const [editForm, setEditForm] = useState<ClaimForm>(EMPTY_FORM);
  const [decision, setDecision] = useState<{
    claim: ClaimRecord;
    action: DecisionAction;
  } | null>(null);
  const [decisionNote, setDecisionNote] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListClaimsQueryKey() });

  // 503 = the clerk_ai kill switch is off (CLERK_DISABLED); 403 = maker-checker
  // refused the decision (CLAIM_SELF_APPROVAL) — relay the server's own words.
  const handleServerError = (err: unknown, fallback: string) => {
    if (killSwitchTripped(err)) {
      setDisabledBanner(true);
      toast({
        title: "Clerk is switched off",
        description:
          "The clerk_ai kill switch is disabled, so the claims register is not accepting changes.",
        variant: "destructive",
      });
      return;
    }
    if (errorStatus(err) === 403) {
      toast({
        title: "Maker-checker blocked this",
        description:
          serverErrorMessage(err) ??
          "The author of a claim version cannot approve it. A second operator must review and approve.",
        variant: "destructive",
      });
      return;
    }
    toast({
      title: "Something went wrong",
      description: serverErrorMessage(err) ?? fallback,
      variant: "destructive",
    });
  };

  const createClaim = useCreateClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        setCreateOpen(false);
        setCreateForm(EMPTY_FORM);
        setExpandedId(claim.id);
        toast({
          title: `Draft ${claim.claimKey} v${claim.version} created`,
          description: "Submit it for review when it is ready.",
        });
      },
      onError: (e) => handleServerError(e, "Could not create the draft."),
    },
  });
  const updateClaim = useUpdateClaim({
    mutation: {
      onSuccess: () => {
        invalidate();
        setDisabledBanner(false);
        setEditing(null);
        toast({ title: "Draft updated" });
      },
      onError: (e) => handleServerError(e, "Could not update the draft."),
    },
  });
  const submitClaim = useSubmitClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        toast({
          title: `${claim.claimKey} v${claim.version} submitted for review`,
          description:
            "A second operator must approve it before the Clerk can quote it.",
        });
      },
      onError: (e) => handleServerError(e, "Could not submit the draft."),
    },
  });
  const decideClaim = useDecideClaim({
    mutation: {
      onSuccess: (claim) => {
        invalidate();
        setDisabledBanner(false);
        setDecision(null);
        setDecisionNote("");
        toast({
          title:
            claim.state === "active"
              ? `${claim.claimKey} v${claim.version} is now active`
              : `${claim.claimKey} v${claim.version} ${claim.state}`,
          description:
            claim.state === "active"
              ? "The Clerk may quote this version from now on."
              : claim.state === "suspended"
                ? "The Clerk can no longer quote this version."
                : undefined,
        });
      },
      onError: (e) => handleServerError(e, "Could not record the decision."),
    },
  });

  // Grouped by claimKey, newest version first within each key.
  const sorted = useMemo(
    () =>
      [...(claims ?? [])].sort(
        (a, b) => a.claimKey.localeCompare(b.claimKey) || b.version - a.version,
      ),
    [claims],
  );

  const saveCreate = () => {
    createClaim.mutate({
      data: {
        claimKey: createForm.claimKey.trim(),
        title: createForm.title.trim(),
        proposition: createForm.proposition.trim(),
        citation: createForm.citation.trim(),
        effectiveFrom: createForm.effectiveFrom,
        effectiveTo: createForm.effectiveTo || null,
        reviewDueAt: createForm.reviewDueAt || null,
        applicability:
          createForm.category === "none"
            ? {}
            : { category: createForm.category },
        protectedFacts: factsPayload(createForm.facts),
      },
    });
  };

  const saveEdit = () => {
    if (!editing) return;
    updateClaim.mutate({
      id: editing.id,
      data: {
        title: editForm.title.trim(),
        proposition: editForm.proposition.trim(),
        citation: editForm.citation.trim(),
        effectiveFrom: editForm.effectiveFrom,
        effectiveTo: editForm.effectiveTo || null,
        reviewDueAt: editForm.reviewDueAt || null,
        applicability:
          editForm.category === "none" ? {} : { category: editForm.category },
        protectedFacts: factsPayload(editForm.facts),
      },
    });
  };

  // Per-row pending: only the row whose mutation is in flight shows busy.
  const rowBusy = (claim: ClaimRecord) =>
    (submitClaim.isPending && submitClaim.variables?.id === claim.id) ||
    (decideClaim.isPending && decideClaim.variables?.id === claim.id);

  // Review-due dates are YYYY-MM-DD, so plain string comparison works. An
  // ACTIVE claim past its review date stays visible in the register, but the
  // Clerk refuses to answer from it until it is re-confirmed — flag it loudly.
  const today = new Date().toISOString().slice(0, 10);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (error)
    return <QueryError thing="the claims register" onRetry={() => refetch()} />;

  const decisionCopy = decision ? DECISION_COPY[decision.action] : null;
  const confirmDisabled =
    decideClaim.isPending ||
    (decisionCopy?.noteRequired === true && !decisionNote.trim());

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1
            className="text-2xl font-semibold flex items-center gap-2"
            data-testid="text-page-title"
          >
            <BookMarked className="w-6 h-6" aria-hidden="true" /> Claims
            register
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every binding fact Clerk states comes from an active record here.
            Maker-checker: the author of a version can never approve it.
          </p>
        </div>
        <Button
          onClick={() => setCreateOpen((o) => !o)}
          data-testid="button-new-claim"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New claim
          version
        </Button>
      </div>

      {disabledBanner && (
        <Alert variant="destructive" data-testid="banner-clerk-disabled">
          <PowerOff className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Clerk is switched off</AlertTitle>
          <AlertDescription>
            The <code>clerk_ai</code> feature flag is disabled. The register is
            read-only while it is off — re-enable it under Feature flags.
          </AlertDescription>
        </Alert>
      )}

      {createOpen && (
        <Card data-testid="card-new-claim">
          <CardHeader>
            <CardTitle className="text-base">New claim version</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <ClaimFormFields
              form={createForm}
              setForm={setCreateForm}
              keyLocked={false}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => setCreateOpen(false)}
                data-testid="button-cancel-create"
              >
                Cancel
              </Button>
              <Button
                onClick={saveCreate}
                disabled={formInvalid(createForm) || createClaim.isPending}
                data-testid="button-create-claim"
              >
                {createClaim.isPending ? "Creating…" : "Create draft"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          {sorted.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-empty">
              No claims yet. Create a draft version to get started.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Claim</th>
                    <th className="py-2 pr-3 font-medium">Title</th>
                    <th className="py-2 pr-3 font-medium">State</th>
                    <th className="py-2 pr-3 font-medium">Citation</th>
                    <th className="py-2 pr-3 font-medium">Effective</th>
                    <th className="py-2 pr-3 font-medium">Review due</th>
                    <th className="py-2 pr-3 font-medium text-right">Facts</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {sorted.map((claim) => {
                    const expanded = expandedId === claim.id;
                    const busy = rowBusy(claim);
                    const Chevron = expanded ? ChevronDown : ChevronRight;
                    return (
                      <Fragment key={claim.id}>
                        <tr
                          className="hover:bg-muted/40"
                          data-testid={`row-claim-${claim.claimKey}-v${claim.version}`}
                        >
                          <td className="py-2.5 pr-3 align-top">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedId(expanded ? null : claim.id)
                              }
                              className="flex items-center gap-1.5 text-left"
                              aria-expanded={expanded}
                              data-testid={`button-expand-${claim.id}`}
                            >
                              <Chevron
                                className="w-4 h-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <code className="text-xs">{claim.claimKey}</code>
                              <span className="text-xs text-muted-foreground">
                                v{claim.version}
                              </span>
                            </button>
                          </td>
                          <td className="py-2.5 pr-3 align-top max-w-56">
                            <span className="block truncate">{claim.title}</span>
                          </td>
                          <td className="py-2.5 pr-3 align-top">
                            <span
                              className={pillClasses(
                                STATE_TONE[claim.state] ?? "slate",
                              )}
                            >
                              {claim.state}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 align-top max-w-40">
                            <span className="block truncate text-muted-foreground">
                              {claim.citation}
                            </span>
                          </td>
                          <td className="py-2.5 pr-3 align-top whitespace-nowrap text-muted-foreground">
                            {formatDate(claim.effectiveFrom)} →{" "}
                            {claim.effectiveTo
                              ? formatDate(claim.effectiveTo)
                              : "open"}
                          </td>
                          <td className="py-2.5 pr-3 align-top whitespace-nowrap">
                            {!claim.reviewDueAt ? (
                              <span className="text-muted-foreground">—</span>
                            ) : claim.state === "active" &&
                              claim.reviewDueAt.slice(0, 10) < today ? (
                              <span
                                className={pillClasses("red")}
                                data-testid={`badge-review-overdue-${claim.id}`}
                              >
                                {formatDate(claim.reviewDueAt)} · overdue
                              </span>
                            ) : (
                              <span className="text-muted-foreground">
                                {formatDate(claim.reviewDueAt)}
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 align-top text-right tabular-nums">
                            {claim.protectedFacts.length}
                          </td>
                          <td className="py-2 align-top">
                            <div className="flex justify-end gap-1.5 flex-wrap">
                              {claim.state === "draft" && (
                                <>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setEditing(claim);
                                      setEditForm(formFromClaim(claim));
                                    }}
                                    disabled={busy}
                                    data-testid={`button-edit-${claim.id}`}
                                  >
                                    <Pencil
                                      className="w-3.5 h-3.5 mr-1"
                                      aria-hidden="true"
                                    />
                                    Edit
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() =>
                                      submitClaim.mutate({ id: claim.id })
                                    }
                                    disabled={busy}
                                    data-testid={`button-submit-${claim.id}`}
                                  >
                                    <Send
                                      className="w-3.5 h-3.5 mr-1"
                                      aria-hidden="true"
                                    />
                                    {busy
                                      ? "Submitting…"
                                      : "Submit for review"}
                                  </Button>
                                </>
                              )}
                              {claim.state === "review" && (
                                <>
                                  <Button
                                    size="sm"
                                    onClick={() => {
                                      setDecision({ claim, action: "approve" });
                                      setDecisionNote("");
                                    }}
                                    disabled={busy}
                                    data-testid={`button-approve-${claim.id}`}
                                  >
                                    Approve
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="destructive"
                                    onClick={() => {
                                      setDecision({ claim, action: "reject" });
                                      setDecisionNote("");
                                    }}
                                    disabled={busy}
                                    data-testid={`button-reject-${claim.id}`}
                                  >
                                    Reject
                                  </Button>
                                </>
                              )}
                              {claim.state === "active" && (
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => {
                                    setDecision({ claim, action: "suspend" });
                                    setDecisionNote("");
                                  }}
                                  disabled={busy}
                                  data-testid={`button-suspend-${claim.id}`}
                                >
                                  Suspend
                                </Button>
                              )}
                              {claim.state === "suspended" && (
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    decideClaim.mutate({
                                      id: claim.id,
                                      data: { action: "resume", note: null },
                                    })
                                  }
                                  disabled={busy}
                                  data-testid={`button-resume-${claim.id}`}
                                >
                                  {busy ? "Resuming…" : "Resume"}
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-muted/30">
                            <td colSpan={8} className="px-4 py-3">
                              <ClaimDetail claim={claim} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Approve / reject / suspend — the note travels with the audit trail. */}
      <Dialog
        open={decision != null}
        onOpenChange={(o) => {
          if (!o) {
            setDecision(null);
            setDecisionNote("");
          }
        }}
      >
        <DialogContent>
          {decision && decisionCopy && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {decisionCopy.title} {decision.claim.claimKey} v
                  {decision.claim.version}
                </DialogTitle>
                <DialogDescription>{decisionCopy.help}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor="decision-note">
                  Decision note{" "}
                  {decisionCopy.noteRequired ? "(required)" : "(optional)"}
                </Label>
                <Textarea
                  id="decision-note"
                  value={decisionNote}
                  onChange={(e) => setDecisionNote(e.target.value)}
                  placeholder="What did you check it against?"
                  data-testid="input-decision-note"
                />
              </div>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDecision(null);
                    setDecisionNote("");
                  }}
                  data-testid="button-cancel-decision"
                >
                  Cancel
                </Button>
                <Button
                  variant={
                    decision.action === "approve" ? "default" : "destructive"
                  }
                  onClick={() =>
                    decideClaim.mutate({
                      id: decision.claim.id,
                      data: {
                        action: decision.action,
                        note: decisionNote.trim() ? decisionNote.trim() : null,
                      },
                    })
                  }
                  disabled={confirmDisabled}
                  data-testid="button-confirm-decision"
                >
                  {decideClaim.isPending ? "Recording…" : decisionCopy.confirm}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Edit a draft — same form as create, key locked. */}
      <Dialog
        open={editing != null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Edit draft {editing?.claimKey} v{editing?.version}
            </DialogTitle>
            <DialogDescription>
              Only drafts can be edited. Drafts are invisible to the Clerk
              until a second operator approves them.
            </DialogDescription>
          </DialogHeader>
          <ClaimFormFields form={editForm} setForm={setEditForm} keyLocked />
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setEditing(null)}
              data-testid="button-cancel-edit"
            >
              Cancel
            </Button>
            <Button
              onClick={saveEdit}
              disabled={formInvalid(editForm) || updateClaim.isPending}
              data-testid="button-save-claim"
            >
              {updateClaim.isPending ? "Saving…" : "Save draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
