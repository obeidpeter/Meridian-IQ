import { useMemo, useState } from "react";
import {
  useGetMe,
  useListErrorCatalogue,
  useListUnmappedErrorCodes,
  useUpsertErrorCatalogueEntry,
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
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, BookOpen, Pencil, Plus, Search } from "lucide-react";
import { formatDateTime } from "@/lib/format";

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
  const { data: me } = useGetMe();
  const canWrite = (me?.capabilities ?? []).includes("catalogue.write");
  const { data: entries, isLoading } = useListErrorCatalogue();
  const { data: unmapped } = useListUnmappedErrorCodes({
    query: {
      enabled: canWrite,
      queryKey: getListUnmappedErrorCodesQueryKey(),
    },
  });
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const upsert = useUpsertErrorCatalogueEntry();

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
            <Plus className="w-4 h-4 mr-1" /> New entry
          </Button>
        )}
      </div>

      {canWrite && (unmapped ?? []).length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50" data-testid="card-unmapped">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-amber-900">
              <AlertTriangle className="w-4 h-4" /> Unmapped failure codes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-sm text-amber-900/80">
              These codes appeared on submission attempts but have no catalogue
              entry (INT-02 target: under 2% of failures unmapped).
            </p>
            <div className="flex flex-wrap gap-2">
              {(unmapped ?? []).map((u) => (
                <button
                  key={u.code}
                  onClick={() => openNew(u.code)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-medium hover:bg-amber-100 transition-colors"
                  data-testid={`button-map-${u.code}`}
                >
                  <code>{u.code}</code>
                  <span className="text-muted-foreground">
                    ×{u.occurrences}
                  </span>
                  <Plus className="w-3 h-3" />
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
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
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground" data-testid="text-empty">
          No catalogue entries match.
        </p>
      ) : (
        <div className="space-y-3">
          {filtered.map((entry) => (
            <Card key={entry.code} data-testid={`entry-${entry.code}`}>
              <CardContent className="pt-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1.5">
                    <p className="font-mono text-sm font-semibold flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-primary shrink-0" />
                      {entry.code}
                      {entry.category && (
                        <span className="rounded-full border px-2 py-0.5 text-xs font-sans font-normal text-muted-foreground">
                          {entry.category}
                        </span>
                      )}
                      {entry.retriable && (
                        <span className="rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-xs font-sans font-normal text-emerald-800">
                          retriable
                        </span>
                      )}
                      {entry.source === "operator" && (
                        <span className="rounded-full bg-blue-100 border border-blue-200 px-2 py-0.5 text-xs font-sans font-normal text-blue-800">
                          operator-edited
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
                      data-testid={`button-edit-${entry.code}`}
                    >
                      <Pencil className="w-4 h-4" />
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
