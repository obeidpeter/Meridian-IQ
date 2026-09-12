import { useRef, useSyncExternalStore } from "react";
import { Save, Trash2 } from "lucide-react";
import type { ProtectedNavigation } from "./protected-navigation";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";

export function UnsavedWorkDialog({
  navigation,
}: {
  navigation: ProtectedNavigation;
}) {
  const work = navigation.work;
  const prompt = useSyncExternalStore(work.subscribe, work.getSnapshot);
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <AlertDialog
      open={Boolean(prompt)}
      onOpenChange={(open) => {
        if (!open) work.stay();
      }}
    >
      <AlertDialogContent
        className="w-[calc(100%-2rem)]"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const invalid = document.querySelector<HTMLElement>(
            '[aria-invalid="true"]',
          );
          if (invalid) invalid.focus();
          else if (returnFocus.current?.isConnected)
            returnFocus.current.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Save your changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes. Save them before leaving, discard them, or
            stay on this page.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {prompt?.error ? (
          <p role="alert" className="text-sm text-destructive">
            {prompt.error}
          </p>
        ) : null}
        <p role="status" className="text-sm text-muted-foreground">
          {prompt?.busy ? "Saving changes..." : ""}
        </p>
        <AlertDialogFooter className="gap-2 sm:space-x-0">
          <AlertDialogCancel onClick={work.stay}>Stay</AlertDialogCancel>
          <Button
            variant="outline"
            disabled={prompt?.busy}
            onClick={work.discard}
          >
            <Trash2 aria-hidden="true" />
            Discard
          </Button>
          <Button
            aria-disabled={prompt?.busy || undefined}
            aria-busy={prompt?.busy || undefined}
            onClick={() => void work.save()}
          >
            <Save aria-hidden="true" />
            Save
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
