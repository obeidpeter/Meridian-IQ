import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListInvoiceRoomsQueryKey,
  useListInvoiceRooms,
  useRevokeInvoiceRoom,
} from "@workspace/api-client-react";
import type { InvoiceRoomSummary } from "@workspace/api-client-react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Link2,
  Loader2,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  Metric,
  MetricStrip,
  SegmentedControl,
  WorkspaceHeader,
} from "@workspace/web-ui";
import {
  InvoiceRoomComposer,
  invoiceRoomStatusLabel,
  invoiceRoomTone,
} from "@/components/invoice-room-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import {
  formatAmount,
  formatDate,
  formatDateTime,
  pillClasses,
} from "@/lib/format";

type RoomFilter = "all" | "attention" | "awaiting" | "responded" | "paid";
const EMPTY_ROOMS: InvoiceRoomSummary[] = [];

function matchesFilter(room: InvoiceRoomSummary, filter: RoomFilter): boolean {
  if (filter === "all") return true;
  if (filter === "paid") return room.paymentStatus === "confirmed";
  if (filter === "responded") {
    return (
      room.responseState === "confirmed" && room.paymentStatus !== "confirmed"
    );
  }
  if (filter === "attention") {
    return (
      room.status !== "active" ||
      room.responseState === "queried" ||
      room.responseState === "rejected"
    );
  }
  return (
    room.status === "active" &&
    !room.responseState &&
    room.paymentStatus !== "confirmed"
  );
}

function roomProgress(room: InvoiceRoomSummary) {
  return [
    { label: "Issued", complete: true },
    { label: "Opened", complete: Boolean(room.openedAt) },
    { label: "Verified", complete: Boolean(room.verifiedAt) },
    { label: "Reply", complete: Boolean(room.responseState) },
    { label: "Paid", complete: room.paymentStatus === "confirmed" },
  ];
}

function RoomRow({
  room,
  onRevoke,
}: {
  room: InvoiceRoomSummary;
  onRevoke: (room: InvoiceRoomSummary) => void;
}) {
  const replaceable = room.status !== "revoked" ? room : null;
  return (
    <article
      className="border-t px-4 py-4 first:border-t-0 sm:px-5"
      data-testid={`invoice-room-${room.id}`}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(12rem,1.2fr)_minmax(10rem,1fr)_minmax(18rem,1.4fr)_auto] xl:items-center">
        <div className="min-w-0">
          <Link
            href={`/invoices/${room.invoiceId}`}
            className="inline-flex max-w-full items-center gap-1 rounded-sm font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{room.invoiceNumber}</span>
            <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
          </Link>
          <p
            className="mt-1 truncate text-sm text-muted-foreground"
            title={room.buyerName}
          >
            {room.buyerName}
          </p>
          <p className="mt-1 text-sm font-semibold tabular-nums">
            {formatAmount(room.amount, room.currency)}
          </p>
        </div>

        <div>
          <span className={pillClasses(invoiceRoomTone(room))}>
            {invoiceRoomStatusLabel(room)}
          </span>
          <p className="mt-2 text-xs text-muted-foreground">
            {room.lastActivityAt
              ? `Activity ${formatDateTime(room.lastActivityAt)}`
              : `Created ${formatDate(room.createdAt)}`}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Expires {formatDate(room.expiresAt)}
          </p>
        </div>

        <ol
          className="grid grid-cols-5 gap-1"
          aria-label={`Progress for invoice ${room.invoiceNumber}`}
        >
          {roomProgress(room).map((step, index) => (
            <li key={step.label} className="min-w-0 text-center">
              <div className="flex items-center" aria-hidden="true">
                {index > 0 && (
                  <span
                    className={`h-px flex-1 ${step.complete ? "bg-emerald-500" : "bg-border"}`}
                  />
                )}
                <span
                  className={`grid size-5 shrink-0 place-items-center rounded-full border ${step.complete ? "border-emerald-600 bg-emerald-600 text-white" : "border-border bg-background text-muted-foreground"}`}
                >
                  {step.complete ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <span className="size-1 rounded-full bg-current" />
                  )}
                </span>
                {index < 4 && (
                  <span
                    className={`h-px flex-1 ${roomProgress(room)[index + 1]?.complete ? "bg-emerald-500" : "bg-border"}`}
                  />
                )}
              </div>
              <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                {step.label}
              </span>
              <span className="sr-only">
                {step.complete ? "complete" : "pending"}
              </span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-1 xl:justify-end">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="min-h-11 sm:min-h-8"
          >
            <Link href={`/invoices/${room.invoiceId}`}>View invoice</Link>
          </Button>
          <InvoiceRoomComposer
            invoiceId={room.invoiceId}
            invoiceNumber={room.invoiceNumber}
            buyerName={room.buyerName}
            existingRoom={replaceable}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-8"
              >
                {replaceable ? "Replace" : "New link"}
              </Button>
            }
          />
          {room.status === "active" && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onRevoke(room)}
              aria-label={`Revoke room for invoice ${room.invoiceNumber}`}
              title="Revoke secure link"
              className="min-h-11 min-w-11 text-destructive hover:text-destructive sm:min-h-9 sm:min-w-9"
            >
              <XCircle aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

export function InvoiceRooms() {
  usePageTitle("Invoice Rooms");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const rooms = useListInvoiceRooms({
    query: { queryKey: getListInvoiceRoomsQueryKey(), retry: false },
  });
  const revoke = useRevokeInvoiceRoom();
  const [filter, setFilter] = useState<RoomFilter>("all");
  const [search, setSearch] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<InvoiceRoomSummary | null>(
    null,
  );
  const all = rooms.data?.rooms ?? EMPTY_ROOMS;

  const counts = useMemo(
    () => ({
      all: all.length,
      attention: all.filter((room) => matchesFilter(room, "attention")).length,
      awaiting: all.filter((room) => matchesFilter(room, "awaiting")).length,
      responded: all.filter((room) => matchesFilter(room, "responded")).length,
      paid: all.filter((room) => matchesFilter(room, "paid")).length,
    }),
    [all],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all
      .filter((room) => matchesFilter(room, filter))
      .filter(
        (room) =>
          !needle ||
          room.invoiceNumber.toLowerCase().includes(needle) ||
          room.buyerName.toLowerCase().includes(needle) ||
          (room.recipient ?? "").toLowerCase().includes(needle),
      )
      .sort((a, b) =>
        (b.lastActivityAt ?? b.createdAt).localeCompare(
          a.lastActivityAt ?? a.createdAt,
        ),
      );
  }, [all, filter, search]);

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revoke.mutateAsync({ id: revokeTarget.id });
      setRevokeTarget(null);
      await queryClient.invalidateQueries({
        queryKey: getListInvoiceRoomsQueryKey(),
      });
      toast({
        title: "Invoice Room revoked",
        description: `The link for ${revokeTarget.invoiceNumber} no longer works.`,
      });
    } catch (error) {
      toast({
        title: "Could not revoke Invoice Room",
        description: serverErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Receivables"
        title="Invoice Rooms"
        description="Track every secure buyer link from delivery through confirmation and payment."
        actions={
          <Button asChild variant="outline">
            <Link href="/invoices">
              <Link2 aria-hidden="true" /> Choose an invoice
            </Link>
          </Button>
        }
      />

      {rooms.isLoading ? (
        <>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-96 w-full" />
        </>
      ) : rooms.isError ? (
        <QueryError thing="Invoice Rooms" onRetry={() => rooms.refetch()} />
      ) : (
        <>
          <MetricStrip label="Invoice Room summary">
            <Metric
              label="Active rooms"
              value={String(
                all.filter((room) => room.status === "active").length,
              )}
              detail="Secure buyer links live now"
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
            />
            <Metric
              label="Awaiting buyer"
              value={String(counts.awaiting)}
              detail="No response recorded yet"
              tone={counts.awaiting > 0 ? "warning" : "default"}
              icon={<Clock3 className="size-4" aria-hidden="true" />}
            />
            <Metric
              label="Needs attention"
              value={String(counts.attention)}
              detail="Queries, rejections or closed links"
              tone={counts.attention > 0 ? "critical" : "default"}
              icon={<AlertTriangle className="size-4" aria-hidden="true" />}
            />
            <Metric
              label="Payment confirmed"
              value={String(counts.paid)}
              detail="Rooms with settlement evidence"
              tone="positive"
              icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
            />
          </MetricStrip>

          <Card className="overflow-hidden">
            <div className="flex flex-col gap-4 border-b p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
              <SegmentedControl<RoomFilter>
                label="Filter Invoice Rooms"
                value={filter}
                onChange={setFilter}
                items={[
                  { value: "all", label: "All", count: counts.all },
                  {
                    value: "attention",
                    label: "Attention",
                    count: counts.attention,
                  },
                  {
                    value: "awaiting",
                    label: "Awaiting",
                    count: counts.awaiting,
                  },
                  {
                    value: "responded",
                    label: "Confirmed",
                    count: counts.responded,
                  },
                  { value: "paid", label: "Paid", count: counts.paid },
                ]}
              />
              <div className="relative w-full lg:w-72">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search invoice or buyer"
                  aria-label="Search Invoice Rooms"
                  className="pl-9"
                />
              </div>
            </div>

            {filtered.length === 0 ? (
              <EmptyState
                icon={search || filter !== "all" ? Search : Link2}
                title={
                  search || filter !== "all"
                    ? "No matching Invoice Rooms"
                    : "No Invoice Rooms yet"
                }
                description={
                  search || filter !== "all"
                    ? "Change the filter or search term to see other rooms."
                    : "Open a stamped invoice and issue a secure buyer link to start tracking delivery, responses and payment."
                }
              >
                {!search && filter === "all" && (
                  <Button asChild className="mt-2">
                    <Link href="/invoices">
                      Choose a stamped invoice
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </Button>
                )}
              </EmptyState>
            ) : (
              <div>
                {filtered.map((room) => (
                  <RoomRow
                    key={room.id}
                    room={room}
                    onRevoke={setRevokeTarget}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      <AlertDialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke {revokeTarget?.invoiceNumber}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The buyer immediately loses access to the secure link. Existing
              activity remains in the audit history and you can issue a new link
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              Keep active
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmRevoke()}
              disabled={revoke.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revoke.isPending ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : null}{" "}
              Revoke link
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
