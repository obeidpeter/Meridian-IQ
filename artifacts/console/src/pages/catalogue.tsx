import { useMemo, useState } from "react";
import {
  useGetMe,
  useListErrorCatalogue,
  useListUnmappedErrorCodes,
  useUpsertErrorCatalogueEntry,
  useDraftCatalogueEntryWithClerk,
  getListErrorCatalogueQueryKey,
  getListUnmappedErrorCodesQueryKey,
} from "@workspace/api-client-react";
import type { ErrorCatalogueEntry } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { AlertTriangle, BookOpen, Pencil, Plus, Search, Sparkles } from "lucide-react";
import { formatDateTime, pillClasses } from "@/lib/format";

// ADV-03: the living error catalogue, updatable by operators within one
// working day of a new failure appearing. INT-02: codes seen on submissions
// with no entry surface at the top as the operator's mapping to-do list.

interface EntryForm {
  code: string;
  category: string;
  cause: string;
  fix: string;
  retriable: boolean;
}

const EMPTY_FORM: EntryForm = {
  code: "",
  category: "mbs",
  cause: "",
  fix: "",
  retriable: false,
};

export function Catalogue() {
  usePageTitle("Error catalogue");
  const { data: me } = useGetMe();
  const canWrite = (me?.capabilities ?? []).includes("catalogue.write");
  const { data: entries, isLoading, error, refetch } = useListErrorCatalogue();
  const { data: unmapped } = useListUnmappedErrorCodes({
    query: {
      enabled: canWrite,
      queryKey: getListUnmappedErrorCodesQueryKey(),
    },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const upsert = useUpsertErrorCatalogueEntry();
  const clerkDraft = useDraftCatalogueEntryWithClerk();

  const [search, setSearch] = useState("");
  const [form, setForm] = useState<EntryForm | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);

  const filtered = useMemo(() => {
    const list = entries ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (e) =>
        e.code.toLowerCase().includes(q) ||
        e.cause.toLowerCase().includes(q) ||
        e.fix.toLowerCase().includes(q) ||
        (e.category ?? "").toLowerCase().includes(q),
    );
  }, [entries, search]);

  const openNew = (code = "") => {
    setEditingExisting(false);
    setForm({ ...EMPTY_FORM, code });
  };
  const openEdit = (entry: ErrorCatalogueEntry) => {
    setEditingExisting(true);
    setForm({
      code: entry.code,
      category: entry.category ?? "mbs",
      cause: entry.cause,
      fix: entry.fix,
      retriable: entry.retriable,
    });
  };

  // Clerk proposes {cause, fix, retriable} from the raw rail rejections
  // observed for the code; the operator reviews the prose in this same form
  // and saves through the ordinary route — nothing is stored until then.
  const draftWithClerk = () => {
    if (!form?.code.trim()) return;
    clerkDraft.mutate(
      { data: { code: form.code.trim() } },
      {
        onSuccess: (draft) => {
          setForm((f) =>
            f
              ? {
                  ...f,
                  cause: draft.cause,
                  fix: draft.fix,
                  retriable: draft.retriable,
                }
              : f,
          );
          toast({
            title: "Draft ready",
            description: `Grounded in ${draft.sampleCount} observed rejection${draft.sampleCount === 1 ? "" : "s"} — review before saving.`,
          });
        },
        onError: () =>
          toast({
            title: "Clerk could not draft this entry",
            description: "Write it manually — the observed rejections may be unusable.",
            variant: "destructive",
          }),
      },
    );
  };

  const save = () => {
    if (!form || !form.code.trim() || !form.cause.trim() || !form.fix.trim())
      return;
    upsert.mutate(
      {
        data: {
          code: form.code.trim(),
          category: form.category.trim() || undefined,
          cause: form.cause.trim(),
          fix: form.fix.trim(),
          retriable: form.retriable,
        },
      },
      {
        onSuccess: () => {
          toast({
            title: `${form.code} ${editingExisting ? "updated" : "added to the catalogue"}`,
          });
          setForm(null);
          queryClient.invalidateQueries({
            queryKey: getListErrorCatalogueQueryKey(),
          });
          queryClient.invalidateQueries({
            queryKey: getListUnmappedErrorCodesQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Could not save entry", variant: "destructive" }),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            Error catalogue
          </h1>
          <p className="text-muted-foreground mt-1">
            Every MBS rejection mapped to a plain-language cause and fix — the
            playbook behind guided resolution and the operator queue.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => openNew()} data-testid="button-new-entry">
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New entry
          </Button>
        )}
      </div>

      {canWrite && (unmapped ?? []).length > 0 && (
        <Card
          className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/40"
          data-testid="card-unmapped"
        >
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-amber-900 dark:text-amber-200">
              <AlertTriangle className="w-4 h-4" aria-hidden="true" /> Unmapped
              failure codes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-amber-900/80 dark:text-amber-200/80">
              These codes appeared on submission attempts but have no catalogue
              entry (INT-02 target: under 2% of failures unmapped).
            </p>
            <div className="flex flex-wrap gap-2">
              {(unmapped ?? []).map((u) => (
                <button
                  key={u.code}
                  onClick={() => openNew(u.code)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-card px-3 py-1.5 min-h-9 text-xs font-medium hover:bg-amber-100 dark:border-amber-800 dark:hover:bg-amber-900/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  data-testid={`button-map-${u.code}`}
                >
                  <code>{u.code}</code>
                  <span className="text-muted-foreground">
                    ×{u.occurrences}
                  </span>
                  <Plus className="w-3 h-3" aria-hidden="true" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative max-w-sm">
        <Label htmlFor="catalogue-search" className="sr-only">
          Search the catalogue
        </Label>
        <Search
          className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="catalogue-search"
          className="pl-8"
          placeholder="Search code, cause or fix…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-search"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : error ? (
        <QueryError thing="the error catalogue" onRetry={() => refetch()} />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center gap-2">
            <BookOpen
              className="w-10 h-10 text-muted-foreground"
              aria-hidden="true"
            />
            <p className="font-semibold" data-testid="text-empty">
              {search.trim()
                ? "No entries match your search"
                : "No catalogue entries yet"}
            </p>
            <p className="text-sm text-muted-foreground">
              {search.trim()
                ? "Try a different code, cause or fix."
                : "Entries appear as operators map failure codes to plain-language causes and fixes."}
            </p>
            {search.trim() && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSearch("")}
                data-testid="button-clear-search"
              >
                Clear search
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <Card key={entry.code} data-testid={`entry-${entry.code}`}>
              <CardContent className="pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <p className="font-mono text-sm font-semibold flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
                      {entry.code}
                      {entry.category && (
                        <span className="rounded-full border px-2 py-0.5 text-xs font-sans font-normal text-muted-foreground">
                          {entry.category}
                        </span>
                      )}
                      {entry.retriable && (
                        <span className={`${pillClasses("emerald")} font-sans`}>
                          Retriable
                        </span>
                      )}
                      {entry.source === "operator" && (
                        <span className={`${pillClasses("blue")} font-sans`}>
                          Operator-edited
                        </span>
                      )}
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Cause:</span>{" "}
                      <span className="text-muted-foreground">{entry.cause}</span>
                    </p>
                    <p className="text-sm">
                      <span className="font-medium">Fix:</span>{" "}
                      <span className="text-muted-foreground">{entry.fix}</span>
                    </p>
                    {entry.updatedAt && (
                      <p className="text-xs text-muted-foreground">
                        Updated {formatDateTime(entry.updatedAt)}
                      </p>
                    )}
                  </div>
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(entry)}
                      aria-label={`Edit ${entry.code}`}
                      data-testid={`button-edit-${entry.code}`}
                    >
                      <Pencil className="w-4 h-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingExisting ? `Edit ${form?.code}` : "New catalogue entry"}
            </DialogTitle>
            <DialogDescription>
              Plain Nigerian-English, written for the client who just saw the
              failure — name the field and the fix.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cat-code">Code</Label>
                <Input
                  id="cat-code"
                  value={form.code}
                  disabled={editingExisting}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="MBS_…"
                  data-testid="input-code"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cat-category">Category</Label>
                <Input
                  id="cat-category"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  placeholder="mbs / rail / import"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cat-cause">Cause</Label>
                <Textarea
                  id="cat-cause"
                  value={form.cause}
                  onChange={(e) => setForm({ ...form, cause: e.target.value })}
                  placeholder="What went wrong, in plain language."
                  data-testid="input-cause"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cat-fix">Fix</Label>
                <Textarea
                  id="cat-fix"
                  value={form.fix}
                  onChange={(e) => setForm({ ...form, fix: e.target.value })}
                  placeholder="What the client (or operator) should do next."
                  data-testid="input-fix"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.retriable}
                  onCheckedChange={(v) =>
                    setForm({ ...form, retriable: v === true })
                  }
                />
                Retriable — a resubmission can succeed without changes
              </label>
            </div>
          )}
          <DialogFooter>
            {!editingExisting && (
              <Button
                variant="outline"
                onClick={draftWithClerk}
                disabled={clerkDraft.isPending || !form?.code.trim()}
                data-testid="button-clerk-draft-entry"
              >
                <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
                {clerkDraft.isPending ? "Drafting…" : "Draft with Clerk"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setForm(null)}>
              Discard
            </Button>
            <Button
              onClick={save}
              disabled={
                upsert.isPending ||
                !form?.code.trim() ||
                !form?.cause.trim() ||
                !form?.fix.trim()
              }
              data-testid="button-save-entry"
            >
              {upsert.isPending ? "Saving…" : "Save entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
