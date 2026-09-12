import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, X } from "lucide-react";
import { lazyRoute } from "./route-recovery";
import type { RecoveryProps } from "./session-operation-recovery";

export function SessionOperationRecovery(props: RecoveryProps) {
  const [open, setOpen] = useState(false);
  const [History] = useState(() =>
    lazyRoute(() =>
      import("./session-operation-recovery").then((module) => ({
        default: module.SessionActivityCenter,
      })),
    ),
  );
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Operation history"
          title="Operation history"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-md text-current hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Activity className="size-4" aria-hidden="true" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="mi-shortcuts__overlay" />
        <Dialog.Content
          className="mi-shortcuts__content mi-operation-recovery"
          style={{
            width: "min(48rem, calc(100vw - 32px))",
            maxHeight: "85dvh",
            overflowY: "auto",
          }}
        >
          <Dialog.Title>Operation history</Dialog.Title>
          <Dialog.Description className="sr-only">
            Recent work and server-confirmed results
          </Dialog.Description>
          <History
            {...props}
            onOpen={(route) => {
              setOpen(false);
              props.onOpen(route);
            }}
          />
          <Dialog.Close
            className="mi-shortcuts__close"
            aria-label="Close operation history"
            title="Close"
          >
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
