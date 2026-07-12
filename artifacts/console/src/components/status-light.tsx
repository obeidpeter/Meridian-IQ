import {
  useGetInvoiceStatusLight,
  getGetInvoiceStatusLightQueryKey,
} from "@workspace/api-client-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

// Deterministic invoice status light (Clerk v0). The colour is computed
// server-side from invoice + submission state with NO model call, so it is
// always available even when the clerk_ai kill switch is off.

const DOT: Record<string, string> = {
  green: "bg-green-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

const LABEL: Record<string, string> = {
  green: "All good",
  amber: "Needs attention",
  red: "Action required",
};

export function InvoiceStatusLight({ invoiceId }: { invoiceId: string }) {
  const { data, isLoading } = useGetInvoiceStatusLight(invoiceId, {
    query: {
      queryKey: getGetInvoiceStatusLightQueryKey(invoiceId),
      staleTime: 60_000,
    },
  });

  if (isLoading || !data) {
    return (
      <span
        className="w-2.5 h-2.5 rounded-full bg-muted shrink-0"
        aria-hidden="true"
      />
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 shrink-0"
          aria-label={`Status: ${LABEL[data.light] ?? data.light}`}
          data-testid={`status-light-${invoiceId}`}
        >
          <span
            className={`w-2.5 h-2.5 rounded-full ${DOT[data.light] ?? "bg-muted"}`}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-sm" align="end">
        <p className="font-medium mb-1">{LABEL[data.light] ?? data.light}</p>
        <ul className="list-disc pl-4 space-y-0.5 text-muted-foreground">
          {data.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
        <p className="mt-2 text-xs">{data.recommendedAction}</p>
      </PopoverContent>
    </Popover>
  );
}
