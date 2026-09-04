import { useEffect, useId, useRef, useState } from "react";
import {
  getParty,
  listParties,
  useGetMe,
  type Party,
} from "@workspace/api-client-react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const PAGE_SIZE = 30;
export function useDirectoryScope() {
  const { data: me } = useGetMe();
  return me ? `${me.firmId}:${me.userId}:${me.clientPartyId}` : "";
}

export const customerKey = (scope: string, id: string) => [
  "customer-directory",
  scope,
  id,
];

export function useDirectoryCustomer(id: string) {
  const scope = useDirectoryScope();
  return useQuery({
    queryKey: customerKey(scope, id),
    queryFn: ({ signal }) => getParty(id, { signal }),
    enabled: !!scope && !!id,
    staleTime: 60_000,
  });
}

export function CustomerName({ id }: { id: string }) {
  const customer = useDirectoryCustomer(id);
  if (customer.isError) return <span>Customer unavailable</span>;
  return <span>{customer.data?.legalName ?? "Loading customer..."}</span>;
}

export function CustomerDirectoryPicker({
  id,
  value,
  onChange,
  invalid,
  describedBy,
  excludeId,
  disabled,
}: {
  id: string;
  value: string;
  onChange: (id: string) => void;
  invalid?: boolean;
  describedBy?: string;
  excludeId?: string;
  disabled?: boolean;
}) {
  const scope = useDirectoryScope();
  const client = useQueryClient();
  const selected = useDirectoryCustomer(value);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const waiting = search.trim() !== term;
  const query = useInfiniteQuery({
    queryKey: ["customer-search", scope, term],
    queryFn: ({ pageParam, signal }) =>
      listParties(
        {
          type: "buyer",
          q: term || undefined,
          limit: PAGE_SIZE,
          offset: pageParam,
        },
        { signal },
      ),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.length === PAGE_SIZE ? pages.length * PAGE_SIZE : undefined,
    enabled: !!scope && open && !waiting,
  });
  const options = waiting
    ? []
    : Array.from(
        new Map(
          (query.data?.pages.flat() ?? [])
            .filter((p) => p.id !== excludeId && p.type === "buyer")
            .map((party) => [party.id, party]),
        ).values(),
      );
  useEffect(() => {
    if (waiting || !open) {
      void client.cancelQueries({ queryKey: ["customer-search", scope, term] });
    }
    setActive(-1);
  }, [waiting, term, open, scope, client]);
  useEffect(() => {
    setOpen(false);
    setSearch("");
    setTerm("");
  }, [scope]);
  const choose = (party: Party) => {
    client.setQueryData(customerKey(scope, party.id), party);
    onChange(party.id);
    input.current?.focus();
    setOpen(false);
    setSearch("");
  };
  const activeId =
    open && active >= 0 && options[active]
      ? `${listId}-${options[active].id}`
      : undefined;
  useEffect(() => {
    if (activeId)
      document.getElementById(activeId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeId]);
  return (
    <div
      ref={root}
      className="relative min-w-0"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
          setSearch("");
        }
      }}
    >
      <div className="relative">
        <Input
          ref={input}
          id={id}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={activeId}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          autoComplete="off"
          disabled={disabled || !scope}
          className="pr-9"
          value={
            open
              ? search
              : (selected.data?.legalName ??
                (value ? "Loading customer..." : ""))
          }
          placeholder="Search customers or TIN"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setSearch(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              setSearch("");
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActive((index) =>
                Math.max(
                  0,
                  Math.min(
                    options.length - 1,
                    index + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (open && event.key === "Enter") {
              event.preventDefault();
              if (options[active]) choose(options[active]);
            }
          }}
        />
        <ChevronDown
          className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      {value && selected.isError && !open && (
        <div className="text-sm text-destructive" role="alert">
          Customer could not be loaded.{" "}
          <Button
            type="button"
            variant="link"
            onClick={() => void selected.refetch()}
          >
            Retry customer
          </Button>
        </div>
      )}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-md">
          <ul
            id={listId}
            role="listbox"
            aria-label="Customers"
            className="max-h-64 overflow-y-auto p-1"
          >
            {options.map((party, index) => (
              <li
                key={party.id}
                id={`${listId}-${party.id}`}
                role="option"
                aria-selected={party.id === value}
                className={`flex cursor-pointer items-start gap-2 rounded-sm px-3 py-2 text-sm ${active === index ? "bg-accent" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(party)}
              >
                <Check
                  className={`mt-0.5 size-4 shrink-0 ${party.id === value ? "" : "invisible"}`}
                  aria-hidden="true"
                />
                <span className="min-w-0 break-words">
                  {party.legalName}
                  <span className="block text-xs text-muted-foreground">
                    {party.tin || "No TIN"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <div
            role="status"
            className="px-3 py-1 text-xs text-muted-foreground"
          >
            {waiting || query.isFetching
              ? "Searching customers..."
              : query.isError
                ? "Customer search failed."
                : options.length === 0
                  ? "No matching customers."
                  : `${options.length} customers loaded`}
          </div>
          {query.isError && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void query.refetch()}
            >
              Retry search
            </Button>
          )}
          {!waiting && query.hasNextPage && (
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={query.isFetching}
              onClick={() => void query.fetchNextPage()}
            >
              Load more customers
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
