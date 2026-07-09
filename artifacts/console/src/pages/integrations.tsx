import { useState } from "react";
import {
  useGetPortfolio,
  useListConnectors,
  useListErpConnections,
  useCreateErpConnection,
  useSyncErpConnection,
  getListErpConnectionsQueryKey,
} from "@workspace/api-client-react";
import type { ErpConnection } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { isFeatureDisabled } from "@/lib/errors";
import { Plug, Plus, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import {
  formatDateTime,
  connectionBadgeClasses,
  humanize,
} from "@/lib/format";

// PL-03 / INT-06: ERP connectors behind the single connector contract. A
// connection binds one client business to one connector; syncs pull AR
// invoices through the outbox. Gated by the R2 `erp_connectors` flag.

export function Integrations() {
  usePageTitle("Integrations");
  const {
    data: connectors,
    isLoading,
    error,
    refetch: refetchConnectors,
  } = useListConnectors();
  const {
    data: connections,
    error: connectionsError,
    refetch: refetchConnections,
  } = useListErpConnections();
  const { data: portfolio } = useGetPortfolio();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateErpConnection();
  const sync = useSyncErpConnection();

  const [showCreate, setShowCreate] = useState(false);
  const [connectorKey, setConnectorKey] = useState("");
  const [clientPartyId, setClientPartyId] = useState("");
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const clientName = (id: string) =>
    (portfolio?.clients ?? []).find((c) => c.clientPartyId === id)?.legalName ??
    id;

  if (isFeatureDisabled(error) || isFeatureDisabled(connectionsError)) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl md:text-3xl font-bold" data-testid="text-page-title">
          ERP integrations
        </h1>
        <FeatureUnavailable feature="ERP connectors" />
      </div>
    );
  }

  const handleCreate = () => {
    if (!connectorKey || !clientPartyId) return;
    create.mutate(
      { data: { connectorKey, clientPartyId } },
      {
        onSuccess: () => {
          toast({ title: "Connection created" });
          setShowCreate(false);
          setConnectorKey("");
          setClientPartyId("");
          queryClient.invalidateQueries({
            queryKey: getListErpConnectionsQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Could not create connection", variant: "destructive" }),
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
            title:
              run.status === "failed"
                ? "Sync failed"
                : `Synced — ${run.importedCount} imported, ${run.skippedCount} skipped`,
            variant: run.status === "failed" ? "destructive" : undefined,
          });
          queryClient.invalidateQueries({
            queryKey: getListErpConnectionsQueryKey(),
          });
        },
        onError: () =>
          toast({ title: "Sync failed", variant: "destructive" }),
        onSettled: () => setSyncingId(null),
      },
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold"
            data-testid="text-page-title"
          >
            ERP integrations
          </h1>
          <p className="text-muted-foreground mt-1">
            Pull AR invoices from the packages your clients already use — one
            connector contract, no core changes.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} data-testid="button-new-connection">
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> Connect a client
        </Button>
      </div>

      <Card data-testid="card-connectors">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Plug className="w-4 h-4 text-primary" aria-hidden="true" /> Available connectors
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-16" />
          ) : error ? (
            <QueryError
              thing="available connectors"
              onRetry={() => refetchConnectors()}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {(connectors ?? []).map((c) => (
                <div key={c.key} className="border rounded-md p-3">
                  <p className="font-medium text-sm">{c.name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {c.description}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-connections">
        <CardHeader>
          <CardTitle className="text-base">Client connections</CardTitle>
        </CardHeader>
        <CardContent>
          {connectionsError ? (
            <QueryError
              thing="client connections"
              onRetry={() => refetchConnections()}
            />
          ) : (connections ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="text-no-connections">
              No connections yet — connect a client to start pulling their
              invoice book.
            </p>
          ) : (
            <div className="divide-y">
              {(connections ?? []).map((connection) => (
                <div
                  key={connection.id}
                  className="flex items-center justify-between gap-3 py-3"
                  data-testid={`connection-${connection.id}`}
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {clientName(connection.clientPartyId)}{" "}
                      <span className="text-muted-foreground font-normal">
                        via {connection.connectorKey}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                      {connection.lastSyncAt ? (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                          Last sync {formatDateTime(connection.lastSyncAt)}
                        </>
                      ) : (
                        "Never synced"
                      )}
                      {connection.lastError && (
                        <span className="text-red-700 dark:text-red-400 inline-flex items-center gap-1">
                          <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                          {connection.lastError}
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={connectionBadgeClasses(connection.status)}>
                      {humanize(connection.status)}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={syncingId === connection.id}
                      onClick={() => handleSync(connection)}
                      data-testid={`button-sync-${connection.id}`}
                    >
                      <RefreshCw
                        className={`w-4 h-4 mr-1 ${syncingId === connection.id ? "animate-spin" : ""}`}
                        aria-hidden="true"
                      />
                      {syncingId === connection.id ? "Syncing…" : "Sync now"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Connect a client to an ERP</DialogTitle>
            <DialogDescription>
              Syncs pull the client's AR invoices into drafts through the
              standard import path — validation still runs before submission.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="connection-client">Client</Label>
              <Select value={clientPartyId} onValueChange={setClientPartyId}>
                <SelectTrigger
                  id="connection-client"
                  data-testid="select-connection-client"
                >
                  <SelectValue placeholder="Pick a client" />
                </SelectTrigger>
                <SelectContent>
                  {(portfolio?.clients ?? []).map((c) => (
                    <SelectItem key={c.clientPartyId} value={c.clientPartyId}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="connection-connector">Connector</Label>
              <Select value={connectorKey} onValueChange={setConnectorKey}>
                <SelectTrigger
                  id="connection-connector"
                  data-testid="select-connector"
                >
                  <SelectValue placeholder="Pick the package" />
                </SelectTrigger>
                <SelectContent>
                  {(connectors ?? []).map((c) => (
                    <SelectItem key={c.key} value={c.key}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!connectorKey || !clientPartyId || create.isPending}
              data-testid="button-create-connection"
            >
              {create.isPending ? "Connecting…" : "Create connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
