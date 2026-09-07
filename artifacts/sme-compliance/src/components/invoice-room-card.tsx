import { useRef, useState, type FormEvent, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListInvoiceRoomsForInvoiceQueryKey,
  getListInvoiceRoomsQueryKey,
  useCreateInvoiceRoom,
  useListInvoiceRoomsForInvoice,
  useReplaceInvoiceRoom,
  useRevokeInvoiceRoom,
} from "@workspace/api-client-react";
import type {
  InvoiceRoomCreateInputDeliveryChannel,
  InvoiceRoomCreated,
  InvoiceRoomSummary,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { formatDate, formatDateTime, pillClasses } from "@/lib/format";

export function invoiceRoomStatusLabel(room: InvoiceRoomSummary): string {
  if (room.status === "revoked") return "Revoked";
  if (room.status === "expired") return "Expired";
  if (room.paymentStatus === "confirmed") return "Paid";
  if (room.responseState === "rejected") return "Rejected";
  if (room.responseState === "queried") return "Query raised";
  if (room.responseState === "confirmed") return "Confirmed";
  if (room.verifiedAt) return "Verified · awaiting response";
  if (room.openedAt) return "Opened · awaiting verification";
  if (room.lastDeliveredAt) return "Delivered";
  return "Link created";
}

export function invoiceRoomTone(
  room: InvoiceRoomSummary,
): "emerald" | "amber" | "red" | "blue" | "slate" | "teal" {
  if (room.paymentStatus === "confirmed" || room.responseState === "confirmed")
    return "emerald";
  if (room.status !== "active" || room.responseState === "rejected")
    return "red";
  if (room.responseState === "queried") return "amber";
  if (room.verifiedAt || room.openedAt) return "blue";
  if (room.lastDeliveredAt) return "teal";
  return "slate";
}

function channelLabel(channel: InvoiceRoomSummary["deliveryChannel"]): string {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "email") return "Email";
  return "Copy link";
}

function safeExpiryDays(value: string): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90 ? parsed : 30;
}

export function InvoiceRoomComposer({
  invoiceId,
  invoiceNumber,
  buyerName,
  existingRoom,
  trigger,
}: {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
  existingRoom?: InvoiceRoomSummary | null;
  trigger?: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] =
    useState<InvoiceRoomCreateInputDeliveryChannel>("email");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [sendNow, setSendNow] = useState(true);
  const [reminders, setReminders] = useState(true);
  const [consent, setConsent] = useState(false);
  const [created, setCreated] = useState<InvoiceRoomCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const requestId = useRef<string | null>(null);
  const create = useCreateInvoiceRoom();
  const replace = useReplaceInvoiceRoom();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isPending = create.isPending || replace.isPending;
  // An expired row still occupies the database's one-unrevoked-room slot, so
  // replacing it is the correct operation. A revoked room has released it.
  const isReplacement = Boolean(
    existingRoom?.status !== "revoked" && existingRoom,
  );

  const reset = () => {
    setChannel("email");
    setEmail("");
    setPhone("");
    setExpiresInDays("30");
    setSendNow(true);
    setReminders(true);
    setConsent(false);
    setCreated(null);
    setCopied(false);
    requestId.current = null;
  };

  const changeOpen = (next: boolean) => {
    if (!next && isPending) return;
    setOpen(next);
    if (!next) reset();
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListInvoiceRoomsQueryKey(),
    });
    void queryClient.invalidateQueries({
      queryKey: getListInvoiceRoomsForInvoiceQueryKey(invoiceId),
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    requestId.current ??= crypto.randomUUID();
    const data = {
      clientRequestId: requestId.current,
      recipientEmail: email.trim() || null,
      recipientPhone: phone.trim() || null,
      deliveryChannel: channel,
      expiresInDays: safeExpiryDays(expiresInDays),
      sendNow: channel === "copy" ? false : sendNow,
      remindersEnabled: channel === "copy" ? false : reminders,
      contactConsent: channel === "copy" ? false : consent,
    };
    try {
      const result =
        isReplacement && existingRoom
          ? await replace.mutateAsync({ id: existingRoom.id, data })
          : await create.mutateAsync({ id: invoiceId, data });
      setCreated(result);
      requestId.current = null;
      invalidate();
      toast({
        title: isReplacement ? "Secure link replaced" : "Invoice Room created",
        description:
          result.delivery.status === "sent"
            ? `The secure link was sent by ${channelLabel(channel).toLowerCase()}.`
            : result.delivery.status === "failed"
              ? "The room is ready, but delivery failed. Copy and send the link below."
              : "Copy the secure link below and send it to the buyer.",
        ...(result.delivery.status === "failed"
          ? { variant: "destructive" as const }
          : {}),
      });
    } catch (error) {
      toast({
        title: "Could not create Invoice Room",
        description: serverErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  const copyLink = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      const field = document.getElementById(
        "invoice-room-url",
      ) as HTMLInputElement | null;
      field?.select();
      toast({
        title: "Select and copy the link",
        description: "Clipboard access is unavailable in this browser.",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button">
            <Link2 className="size-4" aria-hidden="true" />{" "}
            {isReplacement ? "Replace link" : "Open Invoice Room"}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto [&>button.absolute]:size-11 sm:max-w-xl sm:[&>button.absolute]:size-8">
        <DialogHeader>
          <DialogTitle>
            {created
              ? "Secure link ready"
              : isReplacement
                ? "Replace secure invoice link"
                : "Create a secure Invoice Room"}
          </DialogTitle>
          <DialogDescription>
            {created
              ? `Send this one-time link to ${buyerName}. Valo does not expose it again after you close this window.`
              : isReplacement
                ? `The current link for ${invoiceNumber} will stop working as soon as the replacement is created.`
                : `Give ${buyerName} one place to inspect, confirm and settle ${invoiceNumber}.`}
          </DialogDescription>
        </DialogHeader>

        {created ? (
          <div className="space-y-5">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="flex items-center gap-2 font-semibold">
                <ShieldCheck className="size-4" aria-hidden="true" /> The room
                is active until {formatDate(created.room.expiresAt)}.
              </p>
              <p className="mt-1 text-emerald-800">
                Anyone with the link can inspect the invoice. Buyer actions
                require a one-time code sent to the selected contact.
              </p>
            </div>
            <div>
              <Label htmlFor="invoice-room-url">Secure buyer link</Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="invoice-room-url"
                  readOnly
                  value={created.url}
                  className="min-h-11 font-mono text-xs sm:min-h-10"
                  onFocus={(event) => event.currentTarget.select()}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-11 sm:size-9"
                  onClick={() => void copyLink()}
                  aria-label="Copy secure buyer link"
                  title="Copy secure buyer link"
                >
                  {copied ? (
                    <Check className="text-emerald-700" aria-hidden="true" />
                  ) : (
                    <Copy aria-hidden="true" />
                  )}
                </Button>
              </div>
            </div>
            {created.delivery.status === "failed" && (
              <p
                className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
                role="alert"
              >
                <AlertTriangle
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden="true"
                />{" "}
                Delivery failed. The room is still active; copy the link and
                send it through your usual channel.
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                className="min-h-11 sm:min-h-9"
                onClick={() => changeOpen(false)}
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="invoice-room-channel">Delivery method</Label>
              <Select
                value={channel}
                onValueChange={(
                  value: InvoiceRoomCreateInputDeliveryChannel,
                ) => {
                  setChannel(value);
                  if (value === "copy") {
                    setSendNow(false);
                    setReminders(false);
                    setConsent(false);
                  } else {
                    setSendNow(true);
                    setReminders(true);
                  }
                  requestId.current = null;
                }}
              >
                <SelectTrigger
                  id="invoice-room-channel"
                  className="min-h-11 sm:h-9 sm:min-h-9"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">
                    <span className="flex items-center gap-2">
                      <Mail className="size-4" aria-hidden="true" /> Email
                    </span>
                  </SelectItem>
                  <SelectItem value="whatsapp">
                    <span className="flex items-center gap-2">
                      <MessageCircle className="size-4" aria-hidden="true" />{" "}
                      WhatsApp
                    </span>
                  </SelectItem>
                  <SelectItem value="copy">
                    <span className="flex items-center gap-2">
                      <Copy className="size-4" aria-hidden="true" /> Copy link
                      only
                    </span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {(channel === "email" || channel === "copy") && (
              <div className="space-y-2">
                <Label htmlFor="invoice-room-email">
                  Buyer email{channel === "copy" ? " (optional)" : ""}
                </Label>
                <Input
                  id="invoice-room-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    requestId.current = null;
                  }}
                  required={channel === "email"}
                  maxLength={254}
                  placeholder="accounts@buyer.com"
                  className="min-h-11 sm:min-h-10"
                />
              </div>
            )}
            {(channel === "whatsapp" || channel === "copy") && (
              <div className="space-y-2">
                <Label htmlFor="invoice-room-phone">
                  Buyer WhatsApp number
                  {channel === "copy" ? " (optional)" : ""}
                </Label>
                <Input
                  id="invoice-room-phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(event) => {
                    setPhone(event.target.value);
                    requestId.current = null;
                  }}
                  required={channel === "whatsapp"}
                  minLength={8}
                  maxLength={40}
                  placeholder="+234 801 234 5678"
                  className="min-h-11 sm:min-h-10"
                />
                <p className="text-xs text-muted-foreground">
                  Include the country code.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="invoice-room-expiry">Link expires after</Label>
              <Select
                value={expiresInDays}
                onValueChange={(value) => {
                  setExpiresInDays(value);
                  requestId.current = null;
                }}
              >
                <SelectTrigger
                  id="invoice-room-expiry"
                  className="min-h-11 sm:h-9 sm:min-h-9"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="7">7 days</SelectItem>
                  <SelectItem value="14">14 days</SelectItem>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {channel !== "copy" && (
              <div className="divide-y rounded-md border bg-muted/20 px-4">
                <label className="flex min-h-14 cursor-pointer items-center justify-between gap-4 py-3">
                  <span>
                    <span className="block text-sm font-semibold">
                      Send now
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Deliver the secure link when the room is created.
                    </span>
                  </span>
                  <Switch
                    checked={sendNow}
                    onCheckedChange={(value) => {
                      setSendNow(value);
                      requestId.current = null;
                    }}
                    aria-label="Send secure link now"
                  />
                </label>
                <label className="flex min-h-14 cursor-pointer items-center justify-between gap-4 py-3">
                  <span>
                    <span className="block text-sm font-semibold">
                      Payment reminders
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Send controlled due-soon and overdue reminders.
                    </span>
                  </span>
                  <Switch
                    checked={reminders}
                    onCheckedChange={(value) => {
                      setReminders(value);
                      requestId.current = null;
                    }}
                    aria-label="Enable payment reminders"
                  />
                </label>
              </div>
            )}

            {channel !== "copy" && (sendNow || reminders) && (
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => {
                    setConsent(event.target.checked);
                    requestId.current = null;
                  }}
                  required
                  className="mt-0.5 size-4 accent-teal-700"
                />
                <span>
                  <span className="font-semibold">
                    The buyer agreed to receive invoice messages at this
                    contact.
                  </span>
                  <br />
                  Consent is recorded with this room and can be withdrawn by
                  revoking the link.
                </span>
              </label>
            )}

            {channel === "copy" && !email.trim() && !phone.trim() && (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <AlertTriangle
                  className="mr-2 inline size-4"
                  aria-hidden="true"
                />
                Without a contact, the buyer can inspect and download the
                invoice but cannot verify, respond or report payment.
              </p>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 sm:min-h-9"
                onClick={() => changeOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="min-h-11 sm:min-h-9"
                disabled={
                  isPending ||
                  (channel !== "copy" && (sendNow || reminders) && !consent)
                }
              >
                {isPending ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : isReplacement ? (
                  <RefreshCw aria-hidden="true" />
                ) : sendNow ? (
                  <Send aria-hidden="true" />
                ) : (
                  <Link2 aria-hidden="true" />
                )}
                {isPending
                  ? "Creating…"
                  : isReplacement
                    ? "Replace and issue link"
                    : "Create secure room"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function InvoiceRoomCard({
  invoiceId,
  invoiceNumber,
  buyerName,
}: {
  invoiceId: string;
  invoiceNumber: string;
  buyerName: string;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rooms = useListInvoiceRoomsForInvoice(invoiceId, {
    query: {
      enabled: Boolean(invoiceId),
      queryKey: getListInvoiceRoomsForInvoiceQueryKey(invoiceId),
      retry: false,
    },
  });
  const revoke = useRevokeInvoiceRoom();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const active =
    rooms.data?.rooms.find((room) => room.status === "active") ?? null;
  const latest = active ?? rooms.data?.rooms[0] ?? null;

  const revokeRoom = async () => {
    if (!active) return;
    try {
      await revoke.mutateAsync({ id: active.id });
      setConfirmRevoke(false);
      void queryClient.invalidateQueries({
        queryKey: getListInvoiceRoomsForInvoiceQueryKey(invoiceId),
      });
      void queryClient.invalidateQueries({
        queryKey: getListInvoiceRoomsQueryKey(),
      });
      toast({
        title: "Invoice Room revoked",
        description: "The secure buyer link no longer works.",
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
    <Card data-testid="card-invoice-room">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link2 className="size-4" aria-hidden="true" /> Invoice Room
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            A secure buyer page for confirmation, payment and shared evidence.
          </p>
        </div>
        {latest && (
          <span className={pillClasses(invoiceRoomTone(latest))}>
            {invoiceRoomStatusLabel(latest)}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {rooms.isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-9 w-36" />
          </div>
        ) : rooms.isError ? (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
            <span>Invoice Room controls could not be loaded.</span>
            <Button variant="outline" size="sm" onClick={() => rooms.refetch()}>
              <RefreshCw aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : active ? (
          <div className="space-y-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">Delivery</dt>
                <dd className="mt-1 font-medium">
                  {channelLabel(active.deliveryChannel)}
                  {active.recipient ? ` · ${active.recipient}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last activity</dt>
                <dd className="mt-1 font-medium">
                  {active.lastActivityAt
                    ? formatDateTime(active.lastActivityAt)
                    : "No buyer activity"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expires</dt>
                <dd className="mt-1 font-medium">
                  {formatDate(active.expiresAt)}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <a href="/app/invoice-rooms">
                  <ExternalLink aria-hidden="true" /> Open control centre
                </a>
              </Button>
              <InvoiceRoomComposer
                invoiceId={invoiceId}
                invoiceNumber={invoiceNumber}
                buyerName={buyerName}
                existingRoom={active}
                trigger={
                  <Button type="button" variant="outline" size="sm">
                    <RefreshCw aria-hidden="true" /> Replace link
                  </Button>
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmRevoke(true)}
                disabled={revoke.isPending}
                className="text-destructive hover:text-destructive"
              >
                <XCircle aria-hidden="true" /> Revoke
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {latest
                  ? `The previous link is ${latest.status}.`
                  : "No secure buyer room yet."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Issue a protected link without attaching the invoice to email or
                chat.
              </p>
            </div>
            <InvoiceRoomComposer
              invoiceId={invoiceId}
              invoiceNumber={invoiceNumber}
              buyerName={buyerName}
              existingRoom={latest?.status === "expired" ? latest : null}
            />
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this secure link?</AlertDialogTitle>
            <AlertDialogDescription>
              The buyer will immediately lose access. The room’s existing audit
              history remains available, and you can issue a replacement link
              afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              Keep active
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void revokeRoom()}
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
    </Card>
  );
}
