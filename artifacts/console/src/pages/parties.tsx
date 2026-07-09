import { useMemo, useState } from "react";
import {
  useListParties,
  useMergeParties,
  useSplitParty,
  getListPartiesQueryKey,
} from "@workspace/api-client-react";
import type { Party } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  GitMerge,
  Undo2,
  CheckCircle2,
  AlertTriangle,
  Fingerprint,
} from "lucide-react";

// CORE-08 party integrity: duplicate counterparty records are resolved with a
// merge that preserves history (rows are never deleted; lineage is recorded
// via mergedIntoId + the audit log). Without clean parties the fraud layer has
// no reliable raw material — this is the operator's dedupe workbench.

const TYPE_LABELS: Record<Party["type"], string> = {
  client_business: "Client business",
  buyer: "Buyer",
  firm: "Firm",
  bank: "Bank",
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|inc|co|company|group)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

interface DupGroup {
  key: string;
  reason: "same TIN" | "similar name";
  parties: Party[];
}

// Duplicate candidates: live parties sharing a TIN, else a normalized name.
function findDuplicateGroups(parties: Party[]): DupGroup[] {
  const live = parties.filter((p) => !p.mergedIntoId);
  const groups: DupGroup[] = [];
  const seen = new Set<string>();

  const byTin = new Map<string, Party[]>();
  for (const p of live) {
    if (!p.tin) continue;
    const list = byTin.get(p.tin) ?? [];
    list.push(p);
    byTin.set(p.tin, list);
  }
  for (const [tin, list] of byTin) {
    if (list.length > 1) {
      groups.push({ key: `tin:${tin}`, reason: "same TIN", parties: list });
      list.forEach((p) => seen.add(p.id));
    }
  }

  const byName = new Map<string, Party[]>();
  for (const p of live) {
    if (seen.has(p.id)) continue;
    const key = normalizeName(p.legalName);
    if (!key) continue;
    const list = byName.get(key) ?? [];
    list.push(p);
    byName.set(key, list);
  }
  for (const [key, list] of byName) {
    if (list.length > 1) {
      groups.push({ key: `name:${key}`, reason: "similar name", parties: list });
    }
  }
  return groups;
}

export function Parties() {
  const { data: parties, isLoading } = useListParties();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const merge = useMergeParties();
  const split = useSplitParty();

  const [mergeGroup, setMergeGroup] = useState<DupGroup | null>(null);
  const [survivorId, setSurvivorId] = useState("");

  const live = useMemo(
    () => (parties ?? []).filter((p) => !p.mergedIntoId),
    [parties],
  );
  const merged = useMemo(
    () => (parties ?? []).filter((p) => p.mergedIntoId),
    [parties],
  );
  const groups = useMemo(() => findDuplicateGroups(parties ?? []), [parties]);
  const unvalidated = live.filter((p) => !p.tinValidated);
  const nameOf = (id: string | null | undefined) =>
    (parties ?? []).find((p) => p.id === id)?.legalName ?? id ?? "—";

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPartiesQueryKey() });

  const runMerge = async () => {
    if (!mergeGroup || !survivorId) return;
    const duplicates = mergeGroup.parties.filter((p) => p.id !== survivorId);
    try {
      // The API merges one pair at a time; a group folds sequentially into
      // the chosen survivor, each step audit-logged with lineage.
      for (const dup of duplicates) {
        await merge.mutateAsync({
          data: { survivorId, duplicateId: dup.id },
        });
      }
      toast({
        title: `Merged ${duplicates.length} record${duplicates.length === 1 ? "" : "s"}`,
        description: "History preserved — merged rows keep their lineage.",
      });
      setMergeGroup(null);
      setSurvivorId("");
      invalidate();
    } catch (e) {
      toast({
        title: "Merge failed",
        description: e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
      });
    }
  };

  const runSplit = (party: Party) => {
    split.mutate(
      { id: party.id },
      {
        onSuccess: () => {
          toast({ title: `${party.legalName} split back out` });
          invalidate();
        },
        onError: () =>
          toast({ title: "Split failed", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          Party integrity
        </h1>
        <p className="text-muted-foreground mt-1">
          Duplicate resolution with preserved lineage, and TIN-validation
          status — clean parties are the fraud layer's raw material.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card data-testid="stat-parties">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Live parties</p>
            <p className="text-2xl font-bold mt-1">{live.length}</p>
          </CardContent>
        </Card>
        <Card data-testid="stat-validated">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">TIN validated</p>
            <p className="text-2xl font-bold mt-1 text-emerald-700">
              {live.length - unvalidated.length}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-unvalidated">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Unvalidated TIN</p>
            <p className="text-2xl font-bold mt-1 text-amber-600">
              {unvalidated.length}
            </p>
          </CardContent>
        </Card>
        <Card data-testid="stat-dup-groups">
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Duplicate groups</p>
            <p className="text-2xl font-bold mt-1">{groups.length}</p>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <Card data-testid="card-duplicates">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <GitMerge className="w-4 h-4 text-primary" /> Duplicate
                candidates
              </CardTitle>
            </CardHeader>
            <CardContent>
              {groups.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground flex items-center gap-2"
                  data-testid="text-no-duplicates"
                >
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" /> No
                  duplicate candidates — every live party is distinct by TIN
                  and name.
                </p>
              ) : (
                <div className="space-y-3">
                  {groups.map((group) => (
                    <div
                      key={group.key}
                      className="border rounded-md p-3 flex items-start justify-between gap-3"
                      data-testid={`dup-group-${group.key}`}
                    >
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-amber-700 mb-1">
                          {group.reason}
                        </p>
                        {group.parties.map((p) => (
                          <p key={p.id} className="text-sm">
                            <span className="font-medium">{p.legalName}</span>{" "}
                            <span className="text-muted-foreground">
                              · {TYPE_LABELS[p.type]} · TIN {p.tin ?? "—"}
                            </span>
                          </p>
                        ))}
                      </div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setMergeGroup(group);
                          setSurvivorId(group.parties[0].id);
                        }}
                        data-testid={`button-merge-${group.key}`}
                      >
                        <GitMerge className="w-4 h-4 mr-1" /> Merge
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-tin-status">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-primary" /> TIN validation
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unvalidated.length === 0 ? (
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600" /> Every
                  live party has a validated TIN.
                </p>
              ) : (
                <div className="space-y-1.5">
                  <p className="text-sm text-muted-foreground flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                    These parties cannot enter the confirmation workflow until
                    their TIN validates (CORE-08):
                  </p>
                  <div className="divide-y">
                    {unvalidated.map((p) => (
                      <div
                        key={p.id}
                        className="py-2 flex items-center justify-between gap-3"
                        data-testid={`unvalidated-${p.id}`}
                      >
                        <p className="text-sm">
                          <span className="font-medium">{p.legalName}</span>{" "}
                          <span className="text-muted-foreground">
                            · {TYPE_LABELS[p.type]} · TIN {p.tin ?? "missing"}
                          </span>
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {merged.length > 0 && (
            <Card data-testid="card-merge-lineage">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Undo2 className="w-4 h-4 text-primary" /> Merge lineage
                </CardTitle>
              </CardHeader>
              <CardContent className="divide-y">
                {merged.map((p) => (
                  <div
                    key={p.id}
                    className="py-2.5 flex items-center justify-between gap-3"
                    data-testid={`merged-${p.id}`}
                  >
                    <p className="text-sm">
                      <span className="font-medium">{p.legalName}</span>{" "}
                      <span className="text-muted-foreground">
                        merged into {nameOf(p.mergedIntoId)}
                      </span>
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={split.isPending}
                      onClick={() => runSplit(p)}
                      data-testid={`button-split-${p.id}`}
                    >
                      <Undo2 className="w-4 h-4 mr-1" /> Split back out
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}

      <Dialog
        open={mergeGroup !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMergeGroup(null);
            setSurvivorId("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge duplicate parties</DialogTitle>
            <DialogDescription>
              Pick the surviving record. The others are marked merged with full
              lineage — history is preserved, nothing is deleted, and a merge
              can be split back out.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {mergeGroup?.parties.map((p) => (
              <label
                key={p.id}
                className={`flex items-start gap-3 border rounded-md p-3 cursor-pointer transition-colors ${
                  survivorId === p.id ? "border-primary bg-primary/5" : ""
                }`}
              >
                <input
                  type="radio"
                  name="survivor"
                  className="mt-1"
                  checked={survivorId === p.id}
                  onChange={() => setSurvivorId(p.id)}
                  data-testid={`radio-survivor-${p.id}`}
                />
                <span className="text-sm">
                  <span className="font-medium">{p.legalName}</span>
                  <br />
                  <span className="text-muted-foreground">
                    {TYPE_LABELS[p.type]} · TIN {p.tin ?? "—"}
                    {p.tinValidated ? " (validated)" : ""}
                    {p.street ? ` · ${p.street}` : ""}
                    {p.city ? `, ${p.city}` : ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setMergeGroup(null);
                setSurvivorId("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={runMerge}
              disabled={!survivorId || merge.isPending}
              data-testid="button-confirm-merge"
            >
              {merge.isPending ? "Merging…" : "Merge into survivor"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
