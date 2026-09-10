import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FILTERS, FOCUS_RING } from "./constants";
import type { ConfirmationsPageState } from "./use-confirmations-page";

export function QueueFilters({ state }: { state: ConfirmationsPageState }) {
  const {
    search,
    setSearch,
    setPage,
    setServerPage,
    filter,
    setFilter,
    counts,
    deferredSearch,
  } = state;
  return (
    <div className="space-y-3">
      <div className="max-w-sm space-y-1.5">
        <Label htmlFor="invoice-search" className="sr-only">
          Search by invoice number or supplier
        </Label>
        <Input
          id="invoice-search"
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
            setServerPage(0);
          }}
          placeholder="Search invoice number or supplier…"
          data-testid="input-search"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = counts.get(f.key) ?? 0;
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key);
                setPage(1);
                setServerPage(0);
              }}
              aria-pressed={isActive}
              data-testid={`chip-${f.key}`}
              className={`text-xs font-medium px-3 py-1.5 rounded-full border min-h-9 transition-colors ${FOCUS_RING} ${
                isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-foreground hover:bg-muted"
              }`}
            >
              {deferredSearch === "" ? `${f.label} · ${count}` : f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
