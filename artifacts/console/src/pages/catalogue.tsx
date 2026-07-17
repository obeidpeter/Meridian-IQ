import { useMemo, useState } from "react";
import {
  useGetMe,
  useListErrorCatalogue,
  useListUnmappedErrorCodes,
  useUpsertErrorCatalogueEntry,
  useDraftCatalogueEntryWithClerk,
  useListStatementFormats,
  useCreateStatementFormat,
  useDeleteStatementFormat,
  useDraftStatementFormatWithClerk,
  useGetCatalogueCoverage,
  getListErrorCatalogueQueryKey,
  getListUnmappedErrorCodesQueryKey,
  getListStatementFormatsQueryKey,
  getGetCatalogueCoverageQueryKey,
} from "@workspace/api-client-react";
import type {
  ErrorCatalogueEntry,
  StatementColumnMap,
  MappingValidation,
} from "@workspace/api-client-react";
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

// Custom statement formats (Clerk idea #9): operator platform config, like
// the catalogue entries above. Clerk proposes a column mapping from a pasted
// sample; the DETERMINISTIC parser's validation run is shown before the
// operator saves — and the save route re-validates, so a mapping that cannot
// parse its own sample can never be stored.
function StatementFormatsSection() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: formats } = useListStatementFormats();
  const createFormat = useCreateStatementFormat();
  const deleteFormat = useDeleteStatementFormat();
  const clerkFormat = useDraftStatementFormatWithClerk();

  const [open, setOpen] = useState(false);
  const [sample, setSample] = useState("");
  const [bankName, setBankName] = useState("");
  const [columns, setColumns] = useState<StatementColumnMap | null>(null);
  const [validation, setValidation] = useState<MappingValidation | null>(null);

  const reset = () => {
    setSample("");
    setBankName("");
    setColumns(null);
    setValidation(null);
  };

  const draft = () => {
    clerkFormat.mutate(
      { data: { sampleCsv: sample } },
      {
        onSuccess: (d) => {
          setBankName(d.bankName);
          setColumns(d.columns);
          setValidation(d.validation);
        },
        onError: () =>
          toast({
            title: "Clerk could not map that sample",
            description:
              "Check the sample includes the header row, or type the column names manually.",
            variant: "destructive",
          }),
      },
    );
  };

  const save = () => {
    if (!columns || !bankName.trim()) return;
    createFormat.mutate(
      { data: { bankName: bankName.trim(), columns, sampleCsv: sample } },
      {
        onSuccess: () => {
          toast({ title: `${bankName.trim()} format saved` });
          setOpen(false);
          reset();
          queryClient.invalidateQueries({
            queryKey: getListStatementFormatsQueryKey(),
          });
        },
        onError: (e) =>
          toast({
            title: "Could not save the format",
            description:
              e instanceof Error
                ? e.message
                : "The mapping failed validation against the sample.",
            variant: "destructive",
          }),
      },
    );
  };

  const columnField = (key: keyof StatementColumnMap, label: string) => (
    <div className="space-y-1">
      <Label htmlFor={`fmt-${key}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`fmt-${key}`}
        value={(columns?.[key] as string | null | undefined) ?? ""}
        onChange={(e) =>
          setColumns((c) => ({
            ...(c ?? { date: "", narration: "" }),
            [key]: e.target.value || null,
          }))
        }
        placeholder="header name"
      />
    </div>
  );

  return (
    <Card data-testid="card-statement-formats">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          Custom bank-statement formats
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          data-testid="button-new-format"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New from sample
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {(formats ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No custom formats yet. When a client's bank export isn't
            recognised, paste a sample here and Clerk proposes the column
            mapping — the parser validates it before anything is saved.
          </p>
        ) : (
          (formats ?? []).map((f) => (
            <div
              key={f.id}
              className="flex flex-wrap items-center justify-between gap-2 border rounded-md px-3 py-2 text-sm"
              data-testid={`format-${f.key}`}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {f.bankName} <code className="text-xs">{f.key}</code>
                </p>
                <p className="text-xs text-muted-foreground truncate">
                  date: {f.columns.date} · narration: {f.columns.narration}
                  {f.columns.amount ? ` · amount: ${f.columns.amount}` : ""}
                  {f.columns.debit ? ` · debit: ${f.columns.debit}` : ""}
                  {f.columns.credit ? ` · credit: ${f.columns.credit}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  deleteFormat.mutate(
                    { id: f.id },
                    {
                      onSuccess: () =>
                        queryClient.invalidateQueries({
                          queryKey: getListStatementFormatsQueryKey(),
                        }),
                    },
                  )
                }
                aria-label={`Delete ${f.bankName}`}
                data-testid={`button-delete-${f.key}`}
              >
                Delete
              </Button>
            </div>
          ))
        )}
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New statement format</DialogTitle>
            <DialogDescription>
              Paste the export's header row plus a dozen data lines. Clerk
              proposes the mapping; the parser proves it works before you save.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea
              value={sample}
              onChange={(e) => setSample(e.target.value)}
              rows={5}
              placeholder="Date,Narration,Amount,DR/CR&#10;01/07/2026,TRF FROM …,150000.00,CR"
              className="font-mono text-xs"
              data-testid="input-format-sample"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={draft}
              disabled={sample.trim().length < 20 || clerkFormat.isPending}
              data-testid="button-draft-format"
            >
              <Sparkles className="w-4 h-4 mr-1" aria-hidden="true" />
              {clerkFormat.isPending ? "Reading…" : "Draft with Clerk"}
            </Button>
            {columns && (
              <>
                <div className="space-y-1">
                  <Label htmlFor="fmt-bank" className="text-xs">
                    Bank / format name
                  </Label>
                  <Input
                    id="fmt-bank"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value)}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {columnField("date", "Date column")}
                  {columnField("narration", "Narration column")}
                  {columnField("amount", "Amount column (single)")}
                  {columnField("drcr", "DR/CR marker column")}
                  {columnField("debit", "Debit column")}
                  {columnField("credit", "Credit column")}
                </div>
                {validation && (
                  <p
                    className={`text-sm ${
                      validation.parsedCount > 0
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-destructive"
                    }`}
                    data-testid="text-format-validation"
                  >
                    Parser check: {validation.parsedCount} of{" "}
                    {validation.lineCount} sample line(s) parsed (
                    {Math.round(validation.parseRate * 100)}%).
                  </p>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button
              onClick={save}
              disabled={
                !columns || !bankName.trim() || createFormat.isPending
              }
              data-testid="button-save-format"
            >
              {createFormat.isPending ? "Validating…" : "Validate & save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Catalogue coverage (round-13 idea #5): the INT-02 measurement — how much
// rejection traffic the catalogue maps, the age of the unmapped debt, and
// how fast new codes entered the catalogue after first sighting. Pure SQL
// server-side; renders only for catalogue stewards.
function CatalogueCoverageCard({ enabled }: { enabled: boolean }) {
  const { data: coverage, isSuccess } = useGetCatalogueCoverage({
    query: {
      enabled,
      queryKey: getGetCatalogueCoverageQueryKey(),
      retry: false,
    },
  });
  if (!enabled || !isSuccess || !coverage) return null;
  const pct = (v: number | null | undefined) =>
    v == null ? "—" : `${(v * 100).toFixed(1)}%`;
  return (
    <Card data-testid="card-catalogue-coverage">
      <CardHeader>
        <CardTitle className="text-base">
          Coverage — last {coverage.windowDays} days
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
          <div data-testid="coverage-mapped-share">
            <p className="text-xs text-muted-foreground">Rejections mapped</p>
            <p className="text-lg font-semibold tabular-nums">
              {pct(coverage.mappedShare)}
            </p>
            <p className="text-xs text-muted-foreground">
              {coverage.mappedAttempts} of {coverage.codedRejections} coded
              attempts
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Codes seen</p>
            <p className="text-lg font-semibold tabular-nums">
              {coverage.mappedCodes}/{coverage.distinctCodes}
            </p>
            <p className="text-xs text-muted-foreground">mapped today</p>
          </div>
          <div data-testid="coverage-sla">
            <p className="text-xs text-muted-foreground">
              Mapped within a day
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {pct(coverage.sla.withinOneDayShare)}
            </p>
            <p className="text-xs text-muted-foreground">
              {coverage.sla.judged} entr{coverage.sla.judged === 1 ? "y" : "ies"}{" "}
              judged · {coverage.sla.proactive} proactive
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Avg days to map</p>
            <p className="text-lg font-semibold tabular-nums">
              {coverage.sla.avgDaysToMap ?? "—"}
            </p>
            <p className="text-xs text-muted-foreground">
              worst {coverage.sla.maxDaysToMap ?? "—"}
            </p>
          </div>
        </div>
        {coverage.uncodedRejections > 0 && (
          <p className="text-xs text-muted-foreground">
            {coverage.uncodedRejections} rejection(s) carried no code at all —
            those can never be mapped and sit outside the share above.
          </p>
        )}
        {coverage.openUnmapped.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Oldest unmapped debt:{" "}
            {coverage.openUnmapped
              .slice(0, 3)
              .map(
                (u) =>
                  `${u.code} (since ${formatDateTime(u.firstSeen)}${u.openCase ? ", desk case open" : ", NO desk case"})`,
              )
              .join(" · ")}
            {coverage.unmappedTruncated ? " · more exist" : ""}
          </div>
        )}
        {coverage.recentMappings.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Recently mapped:{" "}
            {coverage.recentMappings
              .slice(0, 3)
              .map((m) => `${m.code} in ${m.daysToMap}d`)
              .join(" · ")}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

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

      <CatalogueCoverageCard enabled={canWrite} />

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

      {canWrite && <StatementFormatsSection />}

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
