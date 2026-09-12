import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Clock3,
  FileQuestion,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Button } from "./ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "./ui/sheet";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { evidenceLabel } from "./evidence-helpers";
import { useEvidenceRead } from "./evidence-state";
import type { EvidenceApi, EvidenceOption } from "./evidence-types";

export function EvidenceStatusMark({ status }: { status: string }) {
  const Icon =
    status === "accepted" || status === "clean"
      ? CheckCircle2
      : status === "cancelled" || status === "rejected"
        ? XCircle
        : status === "needs_changes" || status === "quarantined"
          ? ShieldAlert
          : status === "requested"
            ? FileQuestion
            : Clock3;
  return (
    <span className="evidence-status" data-state={status}>
      <Icon aria-hidden="true" />
      {evidenceLabel(status)}
    </span>
  );
}

export function EvidenceErrorMessage({
  error,
  retry,
}: {
  error: string | null | undefined;
  retry?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) ref.current?.focus();
  }, [error]);
  if (!error) return null;
  return (
    <div className="evidence-error" role="alert" tabIndex={-1} ref={ref}>
      <span>{error}</span>
      {retry && (
        <Button variant="outline" onClick={retry}>
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      )}
    </div>
  );
}

export function EvidenceSheet({
  title,
  description,
  children,
  onClose,
  dirty = false,
  busy = false,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
  dirty?: boolean;
  busy?: boolean;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!open && !busy) {
            if (dirty) setConfirmClose(true);
            else onClose();
          }
        }}
      >
        <SheetContent
          className="evidence-sheet"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
            else
              document
                .querySelector<HTMLElement>(".evidence-hub button")
                ?.focus();
          }}
        >
          <SheetHeader className="pr-10 text-left mb-5">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription>{description}</SheetDescription>
          </SheetHeader>
          {busy && (
            <p className="evidence-muted" role="status">
              Saving evidence...
            </p>
          )}
          {children}
        </SheetContent>
      </Sheet>
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved evidence?</AlertDialogTitle>
            <AlertDialogDescription>
              Unsaved fields and selected files will be removed from this
              device. A previously sent request may already have been saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmClose(false);
                onClose();
              }}
            >
              Discard and close
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function EvidenceClientPicker({
  api,
  value,
  onChange,
  disabled,
  required = false,
}: {
  api: EvidenceApi;
  value: EvidenceOption | null;
  onChange: (value: EvidenceOption | null) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const clients = useEvidenceRead(
    (signal) => api.clients?.(search, offset, signal) ?? Promise.resolve([]),
    [search, offset],
  );
  const options =
    value && !clients.data?.some((client) => client.id === value.id)
      ? [value, ...(clients.data ?? [])]
      : (clients.data ?? []);
  return (
    <div className="grid gap-2 min-w-0">
      <label className="evidence-field">
        <span>Find client</span>
        <input
          type="search"
          value={search}
          maxLength={120}
          disabled={disabled}
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
          autoComplete="off"
        />
      </label>
      <label className="evidence-field">
        <span>Client</span>
        <select
          value={value?.id ?? ""}
          required={required}
          disabled={disabled || clients.loading}
          onChange={(event) =>
            onChange(
              options.find((option) => option.id === event.target.value) ??
                null,
            )
          }
        >
          <option value="">{required ? "Select client" : "All clients"}</option>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <EvidenceClientStatus
        clients={clients}
        empty={options.length === 0}
        offset={offset}
        setOffset={setOffset}
        disabled={disabled}
      />
    </div>
  );
}

function EvidenceClientStatus({
  clients,
  empty,
  offset,
  setOffset,
  disabled,
}: {
  clients: ReturnType<typeof useEvidenceRead<EvidenceOption[]>>;
  empty: boolean;
  offset: number;
  setOffset: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <>
      {" "}
      {clients.loading && (
        <p role="status" className="evidence-muted">
          Loading clients...
        </p>
      )}
      <EvidenceErrorMessage error={clients.error} retry={clients.refresh} />
      {!clients.loading && !clients.error && empty && (
        <p className="evidence-muted">No matching clients.</p>
      )}
      {(offset > 0 || clients.data?.length === 50) && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={!offset || clients.loading || disabled}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous clients
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={
              clients.data?.length !== 50 || clients.loading || disabled
            }
            onClick={() => setOffset(offset + 50)}
          >
            More clients
          </Button>
        </div>
      )}
    </>
  );
}
