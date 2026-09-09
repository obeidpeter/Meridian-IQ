import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Copy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { serverErrorToast } from "@/lib/errors";

// "2026-06-01" -> "June 2026" for the VAT pack month picker.
const PACK_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function packMonthLabel(monthStart: string): string {
  const [y, m] = monthStart.split("-");
  return `${PACK_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

// Both cover-note drafts land the same way: keep the response for the
// caption, seed the editable text, toast on failure.
export function coverNoteHandlers<T extends { note: string }>(
  setNote: (note: T) => void,
  setNoteText: (text: string) => void,
  toast: ReturnType<typeof useToast>["toast"],
) {
  return {
    onSuccess: (res: T) => {
      setNote(res);
      setNoteText(res.note);
    },
    onError: (e: unknown) =>
      serverErrorToast(toast, e, {
        title: "Could not draft the note",
        fallback: "Try again.",
      }),
  };
}

// The drafted cover-note panel the VAT pack and quarterly review cards share:
// a source-dependent caption, the editable text, a clipboard Copy button and
// Discard. Each card passes its own testids so the DOM stays byte-identical.
export function CoverNotePanel({
  periodLabel,
  source,
  destinationWord,
  text,
  onChange,
  onDiscard,
  testIds,
}: {
  periodLabel: string;
  source: string;
  destinationWord: string;
  text: string;
  onChange: (text: string) => void;
  onDiscard: () => void;
  testIds: { panel: string; input: string; copy: string; discard: string };
}) {
  const { toast } = useToast();
  return (
    <div
      className="rounded-md border p-3 space-y-2"
      data-testid={testIds.panel}
    >
      <p className="text-xs font-medium text-muted-foreground">
        Cover note for {periodLabel} —{" "}
        {source === "clerk"
          ? "Clerk phrased the pack's own numbers; edit before sending."
          : "template text (Clerk unavailable); edit before sending."}{" "}
        Nothing is stored — copy it into your {destinationWord}.
      </p>
      <Textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[110px] text-sm"
        data-testid={testIds.input}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              toast({ title: "Copied" });
            } catch {
              toast({
                title: "Could not copy",
                description: "Select the text and copy it manually.",
                variant: "destructive",
              });
            }
          }}
          data-testid={testIds.copy}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" aria-hidden="true" /> Copy
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDiscard}
          data-testid={testIds.discard}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}
