import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// The "?" cheat sheet: single-key accelerators stay invisible until a user
// asks, so the sheet is the whole discoverability story — every binding the
// layout registers must appear here (the layout builds both from one list).

export interface ShortcutRow {
  keys: string[];
  description: string;
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  shortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shortcuts: ShortcutRow[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="dialog-shortcuts">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            These work anywhere in the workspace, except while you are typing
            in a field.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {shortcuts.map((row) => (
            <li
              key={row.description}
              className="flex items-center justify-between gap-4"
            >
              <span>{row.description}</span>
              <span className="flex shrink-0 gap-1">
                {row.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
