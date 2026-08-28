import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";

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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="mi-shortcuts__overlay" />
        <Dialog.Content
          className="mi-shortcuts__content"
          data-testid="dialog-shortcuts"
        >
          <Dialog.Title>Keyboard shortcuts</Dialog.Title>
          <Dialog.Description>
            These work anywhere in the workspace, except while you are typing in
            a field.
          </Dialog.Description>
          <ul>
            {shortcuts.map((row) => (
              <li key={row.description}>
                <span>{row.description}</span>
                <span className="mi-shortcuts__keys">
                  {row.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <Dialog.Close
            className="mi-shortcuts__close"
            aria-label="Close keyboard shortcuts"
            title="Close"
          >
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
