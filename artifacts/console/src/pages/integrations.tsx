import { useMemo, useState } from "react";
import {
  getListConnectorsQueryKey,
  getListErpConnectionsQueryKey,
  useCreateErpConnection,
  useGetIntegrationReadiness,
  useGetMe,
  useGetPortfolio,
  useListConnectors,
  useListErpConnections,
  useSyncErpConnection,
  useTestErpConnection,
  type ErpConnection,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { usePageTitle } from "@/hooks/use-page-title";
import { FeatureUnavailable } from "@/components/feature-unavailable";
import { QueryError } from "@/components/query-error";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Landmark,
  MessageSquareText,
  Plug,
  Plus,
  ReceiptText,
  RefreshCw,
  ServerCog,
  TestTube2,
  WalletCards,
} from "lucide-react";
import {
  formatDateTime,
  connectionBadgeClasses,
  humanize,
} from "@/lib/format";
import { trackUsabilityEvent } from "@workspace/web-ui";

const categoryIcons = {
  tax: ReceiptText,
  payments: WalletCards,
  banking: Landmark,
  messaging: MessageSquareText,
  accounting: ServerCog,
};

export function Integrations() {
  usePageTitle("Connection centre");
  const { data: me } = useGetMe();
  const erpEnabled = new Set(me?.features ?? []).has("erp_connectors");
  const readiness = useGetIntegrationReadiness();
  const registry = useListConnectors({
    query: { queryKey: getListConnectorsQueryKey(), enabled: erpEnabled },
  });
  const connectionList = useListErpConnections(undefined, {
    query: {
      queryKey: getListErpConnectionsQueryKey(),
      enabled: erpEnabled,
    },
  });
  const { data: portfolio } = useGetPortfolio();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateErpConnection();
  const testConnection = useTestErpConnection();
  const sync = useSyncErpConnection();

  const [showCreate, setShowCreate] = useState(false);
  const [connectorKey, setConnectorKey] = useState("");
  const [clientPartyId, setClientPartyId] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [tested, setTested] = useState(false);
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const selectedConnector = useMemo(
    () => registry.data?.find((connector) => connector.key === connectorKey),
    [connectorKey, registry.data],
  );
  const requiredComplete =
    selectedConnector?.configurationFields.every(
      (field) => !field.required || Boolean(config[field.key]?.trim()),
    ) ?? false;

  const clientName = (id: string) =>
    (portfolio?.clients ?? []).find((client) => client.clientPartyId === id)
      ?.legalName ?? id;

  const resetCreate = () => {
    setConnectorKey("");
    setClientPartyId("");
    setConfig({});
    setTested(false);
  };

  const chooseConnector = (key: string) => {
    setConnectorKey(key);
    setConfig({});
    setTested(false);
  };

  const handleTest = () => {
    if (!selectedConnector || !requiredComplete) return;
    testConnection.mutate(
      { data: { connectorKey: selectedConnector.key, authConfig: config } },
      {
        onSuccess: () => {
          setTested(true);
          trackUsabilityEvent("integration_tested", "integrations");
          toast({ title: "Connection test passed" });
        },
        onError: (error) => {
          setTested(false);
          toast({
            title: "Connection test failed",
            description: error instanceof Error ? error.message : undefined,
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleCreate = () => {
    if (!connectorKey || !clientPartyId || !tested) return;
    create.mutate(
      { data: { connectorKey, clientPartyId, authConfig: config } },
      {
        onSuccess: () => {
          toast({ title: "Connection created" });
          setShowCreate(false);
          resetCreate();
          void queryClient.invalidateQueries({
            queryKey: getListErpConnectionsQueryKey(),
          });
        },
        onError: (error) =>
          toast({
            title: "Could not create connection",
            description: error instanceof Error ? error.message : undefined,
            variant: "destructive",
          }),
      },
    );
  };

  const handleSync = (connection: ErpConnection) => {
    setSyncingId(connection.id);
    sync.mutate(
      { id: connection.id },
      {
        onSuccess: (run) => {
          toast({
            title: run.status === "failed" ? "Sync failed" : "Sync queued",
            description:
              run.status === "failed"
                ? run.error ?? undefined
                : "Activity will show the final import outcome.",
            variant: run.status === "failed" ? "destructive" : undefined,
          });
          void queryClient.invalidateQueries({
            queryKey: getListErpConnectionsQueryKey(),
          });
        },
        onError: () => toast({ title: "Sync failed", variant: "destructive" }),
        onSettled: () => setSyncingId(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b pb-5">
        <div>
          <p className="text-xs font-bold uppercase text-primary">Data and delivery</p>
          <h1 className="mt-1 text-2xl font-bold md:text-3xl" data-testid="text-page-title">
            Connection centre
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            See what is live, test provider setup and monitor repeatable data feeds without exposing credentials.
          </p>
        </div>
        {erpEnabled ? (
          <Button onClick={() => setShowCreate(true)} data-testid="button-new-connection">
            <Plus className="size-4" aria-hidden="true" /> Connect a client
          </Button>
        ) : null}
      </header>

      <section aria-labelledby="provider-readiness-title">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 id="provider-readiness-title" className="text-base font-semibold">Provider readiness</h2>
            <p className="text-xs text-muted-foreground">Presence-only configuration; secret values never leave the server.</p>
          </div>
          {readiness.data ? (
            <span className="rounded-md border bg-background px-2.5 py-1 text-xs font-semibold">
              {readiness.data.liveCount} of {readiness.data.totalCount} live
            </span>
          ) : null}
        </div>
        {readiness.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {[0, 1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-28" />)}
          </div>
        ) : readiness.error ? (
          <QueryError thing="provider readiness" onRetry={() => void readiness.refetch()} />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {(readiness.data?.items ?? []).map((item) => {
              const Icon = categoryIcons[item.category];
              return (
                <article key={item.key} className="rounded-md border bg-card p-3" data-testid={`readiness-${item.key}`}>
                  <div className="flex items-start justify-between gap-2">
                    <span className="grid size-8 place-items-center rounded-md bg-muted text-foreground">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <span className={item.status === "live" ? "text-xs font-bold text-emerald-700 dark:text-emerald-400" : "text-xs font-bold text-amber-700 dark:text-amber-300"}>
                      {item.status === "live" ? "Live" : "Sandbox"}
                    </span>
                  </div>
                  <h3 className="mt-3 text-sm font-semibold">{item.label}</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{item.note}</p>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {!erpEnabled ? (
        <FeatureUnavailable feature="ERP connectors" />
      ) : (
        <>
          <Card data-testid="card-connectors">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plug className="size-4 text-primary" aria-hidden="true" /> Accounting adapters
              </CardTitle>
            </CardHeader>
            <CardContent>
              {registry.isLoading ? (
                <Skeleton className="h-20" />
              ) : registry.error ? (
                <QueryError thing="available connectors" onRetry={() => void registry.refetch()} />
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {(registry.data ?? []).map((connector) => (
                    <div key={connector.key} className="rounded-md border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">{connector.name}</p>
                        <span className={connector.mode === "live" ? "text-xs font-semibold text-emerald-700" : "text-xs font-semibold text-amber-700"}>
                          {connector.mode === "live" ? (connector.configured ? "Live" : "Setup needed") : "Sandbox"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-muted-foreground">{connector.description}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card data-testid="card-connections">
            <CardHeader><CardTitle className="text-base">Client connections</CardTitle></CardHeader>
            <CardContent>
              {connectionList.isLoading ? (
                <Skeleton className="h-20" />
              ) : connectionList.error ? (
                <QueryError thing="client connections" onRetry={() => void connectionList.refetch()} />
              ) : (connectionList.data ?? []).length === 0 ? (
                <div className="flex min-h-28 items-center gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  <CircleDashed className="size-5" aria-hidden="true" />
                  No client feed is connected. Test an adapter before saving the first connection.
                </div>
              ) : (
                <div className="divide-y">
                  {(connectionList.data ?? []).map((connection) => (
                    <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 py-3" data-testid={`connection-${connection.id}`}>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {clientName(connection.clientPartyId)} <span className="font-normal text-muted-foreground">via {connection.connectorKey}</span>
                        </p>
                        <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {connection.lastSyncAt ? (
                            <><CheckCircle2 className="size-3 text-emerald-600" aria-hidden="true" />Last sync {formatDateTime(connection.lastSyncAt)}</>
                          ) : "Never synced"}
                          {connection.lastError ? (
                            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400"><AlertTriangle className="size-3" aria-hidden="true" />{connection.lastError}</span>
                          ) : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={connectionBadgeClasses(connection.status)}>{humanize(connection.status)}</span>
                        <Button size="sm" variant="secondary" disabled={syncingId === connection.id} onClick={() => handleSync(connection)}>
                          <RefreshCw className={`size-4 ${syncingId === connection.id ? "animate-spin" : ""}`} aria-hidden="true" />
                          {syncingId === connection.id ? "Queueing…" : "Sync now"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      <Dialog
        open={showCreate}
        onOpenChange={(open) => {
          setShowCreate(open);
          if (!open) resetCreate();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect an accounting feed</DialogTitle>
            <DialogDescription>
              Test the provider first. Saving creates a resumable feed; every imported invoice still passes normal validation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="connection-client">Client</Label>
              <Select value={clientPartyId} onValueChange={setClientPartyId}>
                <SelectTrigger id="connection-client"><SelectValue placeholder="Pick a client" /></SelectTrigger>
                <SelectContent>
                  {(portfolio?.clients ?? []).map((client) => (
                    <SelectItem key={client.clientPartyId} value={client.clientPartyId}>{client.legalName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="connection-connector">Adapter</Label>
              <Select value={connectorKey} onValueChange={chooseConnector}>
                <SelectTrigger id="connection-connector"><SelectValue placeholder="Pick an accounting package" /></SelectTrigger>
                <SelectContent>
                  {(registry.data ?? []).map((connector) => (
                    <SelectItem key={connector.key} value={connector.key} disabled={!connector.configured}>
                      {connector.name}{!connector.configured ? " · setup needed" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedConnector?.configurationFields.map((field) => (
              <div className="space-y-1.5" key={field.key}>
                <Label htmlFor={`connector-${field.key}`}>{field.label}{field.required ? " *" : ""}</Label>
                <Input
                  id={`connector-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={config[field.key] ?? ""}
                  onChange={(event) => {
                    setConfig((current) => ({ ...current, [field.key]: event.target.value }));
                    setTested(false);
                  }}
                  placeholder={field.placeholder}
                  required={field.required}
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
              </div>
            ))}
            {tested ? (
              <p className="flex items-center gap-2 text-sm font-medium text-emerald-700" role="status">
                <CheckCircle2 className="size-4" aria-hidden="true" /> Test passed. The connection is ready to save.
              </p>
            ) : null}
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" onClick={handleTest} disabled={!clientPartyId || !requiredComplete || testConnection.isPending}>
              <TestTube2 className="size-4" aria-hidden="true" />
              {testConnection.isPending ? "Testing…" : "Test connection"}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!tested || create.isPending}>
                {create.isPending ? "Connecting…" : "Save connection"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
