import { useMemo, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Activity, X } from "lucide-react";
import { ActivityCenter } from "./operation-status";
import {
  useOperationJournal,
  type OperationRecoveryClient,
} from "./operation-journal";
import { webSession } from "./session-coordinator";
import { RouteErrorBoundary } from "./route-recovery";

interface OperationIdentity {
  userId: string;
  firmId?: string | null;
  clientPartyId?: string | null;
}
type RequestOperations = (
  path: string,
  options: RequestInit & { responseType: "json" },
) => Promise<unknown>;
export function operationSessionKey(
  me: OperationIdentity | undefined,
): string | null {
  return me
    ? `meridianiq:operations:${me.firmId ?? null}:${me.userId}:${me.clientPartyId ?? null}`
    : null;
}
export function createOperationRecoveryFetcher(
  me: OperationIdentity,
  request: RequestOperations,
): OperationRecoveryClient["fetcher"] {
  const epoch = webSession.getGeneration();
  return async (path, options) => {
    const current = () =>
      !webSession.isEnding() &&
      epoch === webSession.getGeneration() &&
      !options.signal.aborted;
    if (!current()) throw new DOMException("Session changed", "AbortError");
    if (!/^\/api\/operations(?:\/lookup|\/[0-9a-f-]{36})?(?:\?|$)/i.test(path))
      throw new Error("Invalid operation recovery path");
    const result = await request(path, {
      ...options,
      credentials: "same-origin",
      responseType: "json",
      headers: me.firmId ? { "x-firm-id": me.firmId } : {},
    });
    if (!current()) throw new DOMException("Session changed", "AbortError");
    return result;
  };
}
interface RecoveryProps {
  me: OperationIdentity | undefined;
  request: RequestOperations;
  onOpen: (route: string) => void;
}
export function useSessionOperations(
  me: OperationIdentity | undefined,
  request: RequestOperations,
) {
  const userId = me?.userId;
  const firmId = me?.firmId;
  const clientPartyId = me?.clientPartyId;
  const fetcher = useMemo(
    () =>
      userId
        ? createOperationRecoveryFetcher(
            { userId, firmId, clientPartyId },
            request,
          )
        : undefined,
    [userId, firmId, clientPartyId, request],
  );
  return useOperationJournal(
    operationSessionKey(me),
    fetcher ? { fetcher } : undefined,
  );
}
export function SessionActivityCenter({ me, request, onOpen }: RecoveryProps) {
  const key = operationSessionKey(me);
  const journal = useSessionOperations(me, request);
  return (
    <RouteErrorBoundary key={key}>
      <ActivityCenter
        key={key}
        operations={journal.operations}
        onOpen={onOpen}
        onDismiss={journal.dismiss}
        onClearCompleted={journal.clearCompleted}
        syncState={journal.syncState}
        onRefresh={journal.refresh}
        onRecover={journal.recover}
      />
    </RouteErrorBoundary>
  );
}
export function SessionOperationRecovery(props: RecoveryProps) {
  const [open, setOpen] = useState(false);
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
          <SessionActivityCenter
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
