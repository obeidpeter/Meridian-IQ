import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListFirmApiKeys,
  useCreateFirmApiKey,
  useRevokeFirmApiKey,
  getListFirmApiKeysQueryKey,
  useListFirmWebhooks,
  useCreateFirmWebhook,
  useDisableFirmWebhook,
  getListFirmWebhooksQueryKey,
  useListFirmWebhookDeliveries,
  getListFirmWebhookDeliveriesQueryKey,
} from "@workspace/api-client-react";
import type {
  FirmApiKey,
  FirmApiKeyCreated,
  FirmWebhook,
  FirmWebhookCreated,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { QueryError } from "@/components/query-error";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { serverErrorMessage } from "@/lib/errors";
import { formatDateTime, humanize, pillClasses } from "@/lib/format";
import type { BadgeTone } from "@/lib/format";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  KeyRound,
  Plus,
  Webhook,
} from "lucide-react";

// Firm integration credentials (contract 0.41.0): API keys that authenticate
// machine callers, and outbound webhooks that push pointer-only events at a
// firm-registered URL. Both are firm_admin-only surfaces — the server gates
// on the explicit role (routes/integrations.ts firmAdminScope), and the
// route/nav mirror that with RoleGate. Secrets are shown ONCE at creation
// (the TOTP enrolment posture): only a hash is stored server-side, so the
// panels below lean hard on "store it now".

// ---- The machine capability allowlist (mirror of api-keys.ts) --------------
// The server rejects anything outside MACHINE_CAPABILITIES; the dialog only
// offers what can actually be granted, with words for what each verb allows.
export const MACHINE_CAPABILITY_OPTIONS = [
  {
    value: "invoice.read",
    label: "Read invoices",
    description: "Pull invoice data and statuses.",
  },
  {
    value: "invoice.write",
    label: "Write draft invoices",
    description:
      "Create and edit drafts. Submission to the rails stays a human action.",
  },
  {
    value: "statement.write",
    label: "Push bank statements",
    description: "Upload statement files for reconciliation.",
  },
] as const;

// ---- The webhook event catalogue (mirror of webhooks.ts) -------------------
export const WEBHOOK_EVENT_OPTIONS = [
  {
    value: "invoice.stamped",
    label: "Invoice stamped",
    description: "An invoice was accepted and stamped by the rails.",
  },
  {
    value: "invoice.settled",
    label: "Invoice settled",
    description: "A payment was matched and the invoice settled.",
  },
  {
    value: "statement.reconciled",
    label: "Statement reconciled",
    description: "A bank statement finished its reconciliation pass.",
  },
] as const;

/**
 * The receiver-side verification recipe. The stored sha256 of the secret IS
 * the HMAC key (the raw secret is never kept), so the note must say exactly
 * that — a receiver who keys the HMAC with the raw secret will reject every
 * genuine delivery.
 */
export const SIGNATURE_NOTE =
  "Each delivery carries an X-Meridian-Signature header: HMAC-SHA256 of the body keyed by sha256 of your secret (hash your stored secret once, then verify each request body against the header).";

/** Toggle one value in a selection list, preserving first-picked order. */
export function toggleListValue(list: string[], value: string): string[] {
  return list.includes(value)
    ? list.filter((v) => v !== value)
    : [...list, value];
}

/** An API key is live until its revocation stamp exists. */
export function apiKeyStatusLabel(key: Pick<FirmApiKey, "revokedAt">): string {
  return key.revokedAt ? "Revoked" : "Active";
}

export function apiKeyBadgeClasses(key: Pick<FirmApiKey, "revokedAt">): string {
  return pillClasses(key.revokedAt ? "slate" : "emerald");
}

/** Active/disabled pill for a webhook endpoint. */
export function webhookStatusLabel(hook: Pick<FirmWebhook, "active">): string {
  return hook.active ? "Active" : "Disabled";
}

export function webhookBadgeClasses(hook: Pick<FirmWebhook, "active">): string {
  return pillClasses(hook.active ? "emerald" : "slate");
}

// Delivery statuses (webhooks.ts dispatcher): pending = queued for its next
// attempt, failed = an attempt failed and retries remain, dead = gave up
// after the attempt cap, delivered = done.
const DELIVERY_LABELS: Record<string, string> = {
  pending: "Queued",
  delivered: "Delivered",
  failed: "Failed — retrying",
  dead: "Dead — gave up",
};

const DELIVERY_TONES: Record<string, BadgeTone> = {
  pending: "blue",
  delivered: "emerald",
  failed: "amber",
  dead: "red",
};

export function deliveryStatusLabel(status: string): string {
  return DELIVERY_LABELS[status] ?? humanize(status);
}

export function deliveryBadgeClasses(status: string): string {
  return pillClasses(DELIVERY_TONES[status] ?? "slate");
}

/**
 * Client-side vet of the endpoint URL before the create is attempted — the
 * same shape the server enforces (vetWebhookUrl), phrased for the field.
 * Null means "looks sendable"; the server stays the authority.
 */
export function webhookUrlProblem(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter the endpoint URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Enter a full URL, including https://";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The endpoint must use http(s).";
  }
  return null;
}

/** "Last used" line for a key row; a never-used key says so honestly. */
export function lastUsedLine(key: Pick<FirmApiKey, "lastUsedAt">): string {
  return key.lastUsedAt
    ? `Last used ${formatDateTime(key.lastUsedAt)}`
    : "Never used";
}

// ---- Copy-to-clipboard (the landing portal's CopyButton pattern) -----------

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-7 px-2 text-muted-foreground hover:text-foreground"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
          },
          () => {
            /* clipboard unavailable — the value stays selectable on screen */
          },
        );
      }}
    >
      {copied ? (
        <CheckCircle2
          className="h-3.5 w-3.5 text-emerald-600"
          aria-hidden="true"
        />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

// Shown-once secret panel, shared by both create dialogs. The secret exists
// only in the dialog's state — closing it is the last time it can be read.
function SecretPanel({
  secret,
  what,
  note,
}: {
  secret: string;
  what: string;
  note?: string;
}) {
  return (
    <div className="space-y-3">
      <div
        className="rounded-md border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-700 dark:bg-amber-950/40"
        role="alert"
      >
        <p className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
          <AlertCircle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          This {what} is shown once — right now. Store it in your secret
          manager before closing this dialog; we keep only a fingerprint and
          can never show it again.
        </p>
      </div>
      <div className="rounded-md border bg-background p-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase text-muted-foreground">
            Secret
          </p>
          <CopyButton value={secret} label={`Copy ${what}`} />
        </div>
        <code
          className="block break-all font-mono text-xs"
          data-testid="text-shown-once-secret"
        >
          {secret}
        </code>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

// ---- API keys card ----------------------------------------------------------

function ApiKeysCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: keys,
    isLoading,
    error,
    refetch,
  } = useListFirmApiKeys({
    query: { queryKey: getListFirmApiKeysQueryKey(), retry: false },
  });
  const create = useCreateFirmApiKey();
  const revoke = useRevokeFirmApiKey();

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  // The one moment the full key exists client-side.
  const [minted, setMinted] = useState<FirmApiKeyCreated | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<FirmApiKey | null>(null);

  const openCreate = () => {
    setName("");
    setCapabilities([]);
    setCreateError(null);
    setMinted(null);
    setShowCreate(true);
  };

  const handleCreate = () => {
    create.mutate(
      { data: { name: name.trim(), capabilities } },
      {
        onSuccess: (key) => {
          setMinted(key);
          setCreateError(null);
          void queryClient.invalidateQueries({
            queryKey: getListFirmApiKeysQueryKey(),
          });
        },
        onError: (err) =>
          setCreateError(
            serverErrorMessage(err) ?? "Could not create the key. Try again.",
          ),
      },
    );
  };

  const handleRevoke = (key: FirmApiKey) => {
    revoke.mutate(
      { id: key.id },
      {
        onSuccess: () => {
          toast({ title: `Revoked "${key.name}"` });
          void queryClient.invalidateQueries({
            queryKey: getListFirmApiKeysQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not revoke the key",
            description: serverErrorMessage(err),
            variant: "destructive",
          }),
        onSettled: () => setRevokeTarget(null),
      },
    );
  };

  const capabilityLabel = (value: string) =>
    MACHINE_CAPABILITY_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <Card data-testid="card-api-keys">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" aria-hidden="true" />
            API keys
          </span>
          <Button size="sm" onClick={openCreate} data-testid="button-new-api-key">
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New key
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          Machine credentials for server-to-server callers (
          <code className="text-[11px]">Authorization: Bearer mk_…</code>).
          Each key carries exactly the capabilities you pick — nothing can
          submit to the government rails, spend Clerk tokens or manage
          accounts.
        </p>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="your API keys" onRetry={() => refetch()} />
        ) : (keys ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-api-keys"
          >
            No API keys yet — create one to let an integration read or stage
            data for this firm.
          </p>
        ) : (
          <ul className="divide-y" data-testid="list-api-keys">
            {(keys ?? []).map((key) => (
              <li
                key={key.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                data-testid={`row-api-key-${key.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {key.name}{" "}
                    <code className="ml-1 font-mono text-xs text-muted-foreground">
                      {key.keyPrefix}…
                    </code>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    {key.capabilities.map((cap) => (
                      <span key={cap} className={pillClasses("teal")}>
                        {capabilityLabel(cap)}
                      </span>
                    ))}
                    <span>{lastUsedLine(key)}</span>
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={apiKeyBadgeClasses(key)}>
                    {apiKeyStatusLabel(key)}
                  </span>
                  {!key.revokedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setRevokeTarget(key)}
                      data-testid={`button-revoke-${key.id}`}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={showCreate}
        onOpenChange={(o) => {
          if (!o) setShowCreate(false);
        }}
      >
        <DialogContent>
          {minted ? (
            <>
              <DialogHeader>
                <DialogTitle>API key created</DialogTitle>
                <DialogDescription>
                  &quot;{minted.name}&quot; can now authenticate with the
                  capabilities you granted.
                </DialogDescription>
              </DialogHeader>
              <SecretPanel secret={minted.secret} what="API key" />
              <DialogFooter>
                <Button
                  onClick={() => setShowCreate(false)}
                  data-testid="button-close-api-key-secret"
                >
                  I&apos;ve stored it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>New API key</DialogTitle>
                <DialogDescription>
                  The key is scoped to your firm and to the capabilities you
                  pick here. You&apos;ll see the secret exactly once, on the
                  next screen.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-name">Name</Label>
                  <Input
                    id="api-key-name"
                    value={name}
                    maxLength={80}
                    placeholder="e.g. ERP export job"
                    onChange={(e) => setName(e.target.value)}
                    data-testid="input-api-key-name"
                  />
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Capabilities</legend>
                  {MACHINE_CAPABILITY_OPTIONS.map((option) => (
                    <div key={option.value} className="flex items-start gap-2">
                      <Checkbox
                        id={`cap-${option.value}`}
                        checked={capabilities.includes(option.value)}
                        onCheckedChange={() =>
                          setCapabilities((caps) =>
                            toggleListValue(caps, option.value),
                          )
                        }
                        className="mt-0.5"
                        data-testid={`checkbox-cap-${option.value}`}
                      />
                      <Label
                        htmlFor={`cap-${option.value}`}
                        className="font-normal"
                      >
                        <span className="block text-sm">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </Label>
                    </div>
                  ))}
                </fieldset>
                {createError && (
                  <p
                    className="text-sm text-destructive"
                    role="alert"
                    data-testid="text-api-key-error"
                  >
                    {createError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={
                    name.trim() === "" ||
                    capabilities.length === 0 ||
                    create.isPending
                  }
                  data-testid="button-create-api-key"
                >
                  {create.isPending ? "Creating…" : "Create key"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke &quot;{revokeTarget?.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key stops authenticating immediately. This
              cannot be undone — you would mint a new key instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={revoke.isPending}
              onClick={() => revokeTarget && handleRevoke(revokeTarget)}
              data-testid="button-confirm-revoke"
            >
              {revoke.isPending ? "Revoking…" : "Revoke key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---- Webhooks card ----------------------------------------------------------

function WebhookDeliveries({ webhookId }: { webhookId: string }) {
  const { data, isLoading, isError, refetch } = useListFirmWebhookDeliveries(
    webhookId,
    {
      query: {
        queryKey: getListFirmWebhookDeliveriesQueryKey(webhookId),
        retry: false,
      },
    },
  );
  if (isLoading) return <Skeleton className="h-12" />;
  if (isError)
    return <QueryError thing="the deliveries" onRetry={() => refetch()} />;
  if ((data ?? []).length === 0)
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="text-no-deliveries"
      >
        No deliveries yet — they appear here as subscribed events happen.
      </p>
    );
  return (
    <ul className="space-y-2" data-testid="list-deliveries">
      {(data ?? []).map((d) => (
        <li
          key={d.id}
          className="rounded-md border p-2 text-xs"
          data-testid={`row-delivery-${d.id}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className={deliveryBadgeClasses(d.status)}>
              {deliveryStatusLabel(d.status)}
            </span>
            <code className="font-mono">{d.eventType}</code>
            <span className="text-muted-foreground">
              {d.attempts} attempt{d.attempts === 1 ? "" : "s"}
            </span>
          </div>
          <p className="mt-1 text-muted-foreground">
            Created {formatDateTime(d.createdAt)}
            {d.deliveredAt && <> · delivered {formatDateTime(d.deliveredAt)}</>}
          </p>
          {d.lastError && (
            <p className="mt-1 break-all text-red-700 dark:text-red-400">
              {d.lastError}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

function WebhooksCard() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: hooks,
    isLoading,
    error,
    refetch,
  } = useListFirmWebhooks({
    query: { queryKey: getListFirmWebhooksQueryKey(), retry: false },
  });
  const create = useCreateFirmWebhook();
  const disable = useDisableFirmWebhook();

  const [showCreate, setShowCreate] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [urlTouched, setUrlTouched] = useState(false);
  const [registered, setRegistered] = useState<FirmWebhookCreated | null>(null);
  const [disableTarget, setDisableTarget] = useState<FirmWebhook | null>(null);
  // Which endpoint's delivery history is expanded.
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);

  const urlProblem = webhookUrlProblem(url);

  const openCreate = () => {
    setUrl("");
    setEvents([]);
    setCreateError(null);
    setUrlTouched(false);
    setRegistered(null);
    setShowCreate(true);
  };

  const handleCreate = () => {
    create.mutate(
      { data: { url: url.trim(), events } },
      {
        onSuccess: (hook) => {
          setRegistered(hook);
          setCreateError(null);
          void queryClient.invalidateQueries({
            queryKey: getListFirmWebhooksQueryKey(),
          });
        },
        onError: (err) =>
          setCreateError(
            serverErrorMessage(err) ??
              "Could not register the endpoint. Try again.",
          ),
      },
    );
  };

  const handleDisable = (hook: FirmWebhook) => {
    disable.mutate(
      { id: hook.id },
      {
        onSuccess: () => {
          toast({ title: "Webhook disabled" });
          void queryClient.invalidateQueries({
            queryKey: getListFirmWebhooksQueryKey(),
          });
        },
        onError: (err) =>
          toast({
            title: "Could not disable the webhook",
            description: serverErrorMessage(err),
            variant: "destructive",
          }),
        onSettled: () => setDisableTarget(null),
      },
    );
  };

  const eventLabel = (value: string) =>
    WEBHOOK_EVENT_OPTIONS.find((o) => o.value === value)?.label ?? value;

  return (
    <Card data-testid="card-webhooks">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-3 text-base">
          <span className="flex items-center gap-2">
            <Webhook className="w-4 h-4 text-primary" aria-hidden="true" />
            Webhooks
          </span>
          <Button size="sm" onClick={openCreate} data-testid="button-new-webhook">
            <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Add endpoint
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground mb-3">
          We POST subscribed events to your endpoint as they happen. Payloads
          are pointer-only — an entity type and id your systems resolve back
          through the API — never amounts, names or documents.
        </p>
        {isLoading ? (
          <Skeleton className="h-16" />
        ) : error ? (
          <QueryError thing="your webhooks" onRetry={() => refetch()} />
        ) : (hooks ?? []).length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-webhooks"
          >
            No endpoints yet — add one to push stamped/settled invoices and
            reconciled statements into your own systems.
          </p>
        ) : (
          <ul className="divide-y" data-testid="list-webhooks">
            {(hooks ?? []).map((hook) => {
              const deliveriesOpen = openDeliveries === hook.id;
              return (
                <li
                  key={hook.id}
                  className="py-3"
                  data-testid={`row-webhook-${hook.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{hook.url}</p>
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {hook.events.map((event) => (
                          <span key={event} className={pillClasses("violet")}>
                            {eventLabel(event)}
                          </span>
                        ))}
                        <span>
                          Secret{" "}
                          <code className="font-mono">
                            {hook.secretPrefix}…
                          </code>
                        </span>
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className={webhookBadgeClasses(hook)}>
                        {webhookStatusLabel(hook)}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        aria-expanded={deliveriesOpen}
                        aria-controls={`deliveries-${hook.id}`}
                        onClick={() =>
                          setOpenDeliveries(deliveriesOpen ? null : hook.id)
                        }
                        data-testid={`button-deliveries-${hook.id}`}
                      >
                        <ChevronDown
                          className={`w-4 h-4 mr-1 transition-transform ${
                            deliveriesOpen ? "rotate-180" : ""
                          }`}
                          aria-hidden="true"
                        />
                        Deliveries
                      </Button>
                      {hook.active && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDisableTarget(hook)}
                          data-testid={`button-disable-${hook.id}`}
                        >
                          Disable
                        </Button>
                      )}
                    </div>
                  </div>
                  {deliveriesOpen && (
                    <div
                      id={`deliveries-${hook.id}`}
                      className="mt-3 border-l-2 border-muted pl-3"
                      data-testid={`section-deliveries-${hook.id}`}
                    >
                      <WebhookDeliveries webhookId={hook.id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <Dialog
        open={showCreate}
        onOpenChange={(o) => {
          if (!o) setShowCreate(false);
        }}
      >
        <DialogContent>
          {registered ? (
            <>
              <DialogHeader>
                <DialogTitle>Webhook registered</DialogTitle>
                <DialogDescription>
                  Deliveries to{" "}
                  <span className="break-all font-mono text-xs">
                    {registered.url}
                  </span>{" "}
                  start with the next subscribed event.
                </DialogDescription>
              </DialogHeader>
              <SecretPanel
                secret={registered.secret}
                what="signing secret"
                note={SIGNATURE_NOTE}
              />
              <DialogFooter>
                <Button
                  onClick={() => setShowCreate(false)}
                  data-testid="button-close-webhook-secret"
                >
                  I&apos;ve stored it
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Add a webhook endpoint</DialogTitle>
                <DialogDescription>
                  Pick the events to push. You&apos;ll get a signing secret
                  exactly once, on the next screen — deliveries are signed so
                  your receiver can verify they came from us.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="webhook-url">Endpoint URL</Label>
                  <Input
                    id="webhook-url"
                    type="url"
                    value={url}
                    maxLength={500}
                    placeholder="https://example.com/hooks/meridian"
                    onChange={(e) => setUrl(e.target.value)}
                    onBlur={() => setUrlTouched(true)}
                    aria-invalid={urlTouched && !!urlProblem}
                    aria-describedby={
                      urlTouched && urlProblem ? "webhook-url-error" : undefined
                    }
                    data-testid="input-webhook-url"
                  />
                  {urlTouched && urlProblem && (
                    <p
                      id="webhook-url-error"
                      role="alert"
                      className="text-sm text-destructive"
                      data-testid="text-webhook-url-error"
                    >
                      {urlProblem}
                    </p>
                  )}
                </div>
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Events</legend>
                  {WEBHOOK_EVENT_OPTIONS.map((option) => (
                    <div key={option.value} className="flex items-start gap-2">
                      <Checkbox
                        id={`event-${option.value}`}
                        checked={events.includes(option.value)}
                        onCheckedChange={() =>
                          setEvents((selected) =>
                            toggleListValue(selected, option.value),
                          )
                        }
                        className="mt-0.5"
                        data-testid={`checkbox-event-${option.value}`}
                      />
                      <Label
                        htmlFor={`event-${option.value}`}
                        className="font-normal"
                      >
                        <span className="block text-sm">{option.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </Label>
                    </div>
                  ))}
                </fieldset>
                {createError && (
                  <p
                    className="text-sm text-destructive"
                    role="alert"
                    data-testid="text-webhook-error"
                  >
                    {createError}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={handleCreate}
                  disabled={
                    !!urlProblem || events.length === 0 || create.isPending
                  }
                  data-testid="button-create-webhook"
                >
                  {create.isPending ? "Registering…" : "Register endpoint"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={disableTarget !== null}
        onOpenChange={(o) => {
          if (!o) setDisableTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disable this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              Deliveries to{" "}
              <span className="break-all font-mono text-xs">
                {disableTarget?.url}
              </span>{" "}
              stop immediately. The delivery history stays visible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={disable.isPending}
              onClick={() => disableTarget && handleDisable(disableTarget)}
              data-testid="button-confirm-disable"
            >
              {disable.isPending ? "Disabling…" : "Disable endpoint"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ---- Page --------------------------------------------------------------------

export function ApiAccess() {
  usePageTitle("API & webhooks");
  return (
    <div className="space-y-6">
      <div>
        <h1
          className="text-2xl md:text-3xl font-bold"
          data-testid="text-page-title"
        >
          API &amp; webhooks
        </h1>
        <p className="text-muted-foreground mt-1">
          Machine access for your firm: API keys your integrations
          authenticate with, and webhook endpoints we push events to. Secrets
          are shown once at creation and never again.
        </p>
      </div>
      <ApiKeysCard />
      <WebhooksCard />
    </div>
  );
}
