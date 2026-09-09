import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListStatementConnections,
  useListStatementConnectors,
  useCreateStatementConnection,
  useTestStatementConnection,
  useSyncStatementConnection,
  useListStatementSyncRuns,
  getListStatementConnectionsQueryKey,
  getListStatementConnectorsQueryKey,
  getListStatementSyncRunsQueryKey,
} from "@workspace/api-client-react";
import type {
  StatementConnection,
  StatementConnectorInfo,
  StatementSyncRun,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import { QueryError } from "@/components/query-error";
import { ScrollRegion } from "@/components/scroll-region";
import { useToast } from "@/hooks/use-toast";
import { serverErrorMessage } from "@/lib/errors";
import { formatDateTime, pillClasses, type BadgeTone } from "@/lib/format";
import {
  CheckCircle2,
  Landmark,
  Plus,
  RefreshCw,
  TestTube2,
} from "lucide-react";

// Bank-feed connections: a connector pulls statement lines for a client
// party on demand; the lines land through the ordinary statement-ingest flow
// and the matcher has its say like any import. The card is render-on-success
// on purpose — a server that doesn't expose the rail yet (older build,
// feature dark → 404) hides the whole section instead of showing an error.

export const CONNECTION_STATUS_TONE: Record<string, BadgeTone> = {
  active: "emerald",
  disabled: "slate",
};

export const SYNC_RUN_TONE: Record<string, BadgeTone> = {
  running: "amber",
  succeeded: "emerald",
  failed: "red",
};

export function connectorConfigurationComplete(
  connector: StatementConnectorInfo | undefined,
  config: Record<string, string>,
): boolean {
  return Boolean(
    connector?.configured &&
    connector.configurationFields.every(
      (field) => !field.required || Boolean(config[field.key]?.trim()),
    ),
  );
}

export type ConnectorFieldState = "loading" | "error" | "empty" | "ready";

/**
 * What the create dialog's connector picker renders. The registry fetch has
 * no retry, so a failure must surface as an inline error + retry — leaving
 * `connectors` undefined forever would otherwise read as an eternal
 * skeleton.
 */
export function connectorFieldState(
  connectors: StatementConnectorInfo[] | undefined,
  isError: boolean,
): ConnectorFieldState {
  if (isError) return "error";
  if (connectors === undefined) return "loading";
  return connectors.length === 0 ? "empty" : "ready";
}

/** Human name for a connector key, falling back to the key itself. */
export function connectorLabel(
  key: string,
  connectors: StatementConnectorInfo[] | undefined,
): string {
  return connectors?.find((c) => c.key === key)?.name ?? key;
}

export function lastSyncLabel(lastSyncAt: string | null | undefined): string {
  return lastSyncAt
    ? `Last sync ${formatDateTime(lastSyncAt)}`
    : "Never synced";
}

/** One line describing a sync run for the inline after-click status. */
export function syncRunSummary(run: StatementSyncRun): string {
  if (run.status === "failed") return run.error ?? "Sync failed.";
  if (run.status === "running") return "Sync running…";
  const lines = run.linesPulled ?? 0;
  return `Pulled ${lines} line(s)`;
}

export interface ConnectionClientOption {
  clientPartyId: string;
  legalName: string;
}

export function StatementConnectionsCard({
  clients,
}: {
  clients: ConnectionClientOption[];
}) {
  const connections = useListStatementConnections({
    query: { queryKey: getListStatementConnectionsQueryKey(), retry: false },
  });
  // Render-on-success: no card at all until the server answers the list.
  if (!connections.isSuccess) return null;
  return (
    <StatementConnectionsBody
      connections={connections.data}
      clients={clients}
    />
  );
}

function StatementConnectionsBody({
  connections,
  clients,
}: {
  connections: StatementConnection[];
  clients: ConnectionClientOption[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: connectors,
    isError: connectorsIsError,
    refetch: refetchConnectors,
  } = useListStatementConnectors({
    query: { queryKey: getListStatementConnectorsQueryKey(), retry: false },
  });
  const connectorsState = connectorFieldState(connectors, connectorsIsError);

  const invalidateConnections = () =>
    queryClient.invalidateQueries({
      queryKey: getListStatementConnectionsQueryKey(),
    });

  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false);
  const [connectorKey, setConnectorKey] = useState("");
  const [clientPartyId, setClientPartyId] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [tested, setTested] = useState(false);
  const selectedConnector = useMemo(
    () => connectors?.find((connector) => connector.key === connectorKey),
    [connectorKey, connectors],
  );
  const requiredComplete = connectorConfigurationComplete(
    selectedConnector,
    config,
  );

  const create = useCreateStatementConnection({
    mutation: {
      onSuccess: (conn) => {
        invalidateConnections();
        setCreateOpen(false);
        setConnectorKey("");
        setClientPartyId("");
        setConfig({});
        setTested(false);
        toast({
          title: "Connection created",
          description: `${connectorLabel(conn.connectorKey, connectors)} for ${
            conn.clientName ?? "the selected client"
          } — use "Sync now" to pull its first statement lines.`,
        });
      },
      onError: (e) =>
        toast({
          title: "Could not create the connection",
          description:
            serverErrorMessage(e) ?? "Check the config and try again.",
          variant: "destructive",
        }),
    },
  });
  const testConnection = useTestStatementConnection({
    mutation: {
      onSuccess: () => {
        setTested(true);
        toast({ title: "Connection test passed" });
      },
      onError: (e) => {
        setTested(false);
        toast({
          title: "Connection test failed",
          description:
            serverErrorMessage(e) ??
            "Check the provider details and try again.",
          variant: "destructive",
        });
      },
    },
  });

  // Per-connection sync: the 202 hands back the run row; keep the newest one
  // per connection so the row can show what just happened without waiting on
  // the history table.
  const [lastRuns, setLastRuns] = useState<Record<string, StatementSyncRun>>(
    {},
  );
  const sync = useSyncStatementConnection({
    mutation: {
      onSuccess: (run) => {
        setLastRuns((m) => ({ ...m, [run.connectionId]: run }));
        invalidateConnections();
        queryClient.invalidateQueries({
          queryKey: getListStatementSyncRunsQueryKey(run.connectionId),
        });
        toast({
          title: run.status === "failed" ? "Sync failed" : "Sync started",
          description: syncRunSummary(run),
          variant: run.status === "failed" ? "destructive" : undefined,
        });
      },
      onError: (e) =>
        toast({
          title: "Could not start the sync",
          description:
            serverErrorMessage(e) ??
            "A sync may already be running for this connection.",
          variant: "destructive",
        }),
    },
  });

  // Runs history, one connection at a time (a drawer-style expanding row).
  const [openRunsId, setOpenRunsId] = useState<string | null>(null);

  const createDisabled =
    create.isPending || connectorKey === "" || clientPartyId === "" || !tested;

  return (
    <Card
      className="rounded-lg border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-card"
      data-testid="card-statement-connections"
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="w-4 h-4 text-primary" aria-hidden="true" />
          Bank-feed connections
        </CardTitle>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          data-testid="button-new-connection"
        >
          <Plus className="w-4 h-4 mr-1" aria-hidden="true" /> New connection
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Pull a client&apos;s bank statement lines straight from a connector.
          Synced lines land through the ordinary statement-import flow — the
          reconciliation matcher still has its say on every line.
        </p>
        {connections.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-connections-empty"
          >
            No connections configured yet — create one to pull a client&apos;s
            statement lines automatically.
          </p>
        ) : (
          <div className="divide-y">
            {connections.map((conn) => {
              const lastRun = lastRuns[conn.id];
              const runsOpen = openRunsId === conn.id;
              const syncBusy = sync.isPending && sync.variables?.id === conn.id;
              return (
                <div
                  key={conn.id}
                  className="py-3 first:pt-0 last:pb-0 space-y-2"
                  data-testid={`row-connection-${conn.id}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {connectorLabel(conn.connectorKey, connectors)}
                        <span className="text-muted-foreground font-normal">
                          {" "}
                          · {conn.clientName ?? conn.clientPartyId}
                        </span>
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {lastSyncLabel(conn.lastSyncAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={pillClasses(
                          CONNECTION_STATUS_TONE[conn.status] ?? "slate",
                        )}
                        data-testid={`badge-connection-status-${conn.id}`}
                      >
                        {conn.status}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => sync.mutate({ id: conn.id })}
                        disabled={syncBusy}
                        data-testid={`button-sync-${conn.id}`}
                      >
                        <RefreshCw
                          className={`w-3.5 h-3.5 mr-1 ${syncBusy ? "animate-spin" : ""}`}
                          aria-hidden="true"
                        />
                        {syncBusy ? "Syncing…" : "Sync now"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenRunsId(runsOpen ? null : conn.id)}
                        aria-expanded={runsOpen}
                        aria-controls={`connection-runs-${conn.id}`}
                        data-testid={`button-runs-${conn.id}`}
                      >
                        {runsOpen ? "Hide runs" : "Runs"}
                      </Button>
                    </div>
                  </div>
                  {lastRun && (
                    <p
                      className="text-xs flex items-center gap-1.5"
                      data-testid={`text-last-run-${conn.id}`}
                    >
                      <span
                        className={pillClasses(
                          SYNC_RUN_TONE[lastRun.status] ?? "slate",
                        )}
                      >
                        {lastRun.status}
                      </span>
                      <span className="text-muted-foreground">
                        {syncRunSummary(lastRun)}
                      </span>
                    </p>
                  )}
                  {runsOpen && (
                    <div id={`connection-runs-${conn.id}`}>
                      <ConnectionRuns connectionId={conn.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) {
            setConnectorKey("");
            setClientPartyId("");
            setConfig({});
            setTested(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New bank-feed connection</DialogTitle>
            <DialogDescription>
              Pick a connector and the client whose account it reads. Synced
              lines walk the ordinary statement-import path.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Connector</Label>
              {connectorsState === "loading" ? (
                <Skeleton className="h-9" data-testid="skeleton-connectors" />
              ) : connectorsState === "error" ? (
                // A failed registry fetch must not read as an eternal
                // skeleton — inline error + retry, dialog stays usable.
                <QueryError
                  thing="the connector list"
                  onRetry={() => void refetchConnectors()}
                />
              ) : connectorsState === "empty" ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="text-no-connectors"
                >
                  No connectors are registered on this server.
                </p>
              ) : (
                <Select
                  value={connectorKey}
                  onValueChange={(value) => {
                    setConnectorKey(value);
                    setConfig({});
                    setTested(false);
                  }}
                >
                  <SelectTrigger
                    aria-label="Connector"
                    data-testid="select-connector"
                  >
                    <SelectValue placeholder="Pick a connector…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(connectors ?? []).map((c) => (
                      <SelectItem
                        key={c.key}
                        value={c.key}
                        disabled={!c.configured}
                      >
                        {c.name}
                        {!c.configured ? " · setup needed" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {connectorKey !== "" && (
                <p className="text-xs text-muted-foreground">
                  {connectors?.find((c) => c.key === connectorKey)?.description}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>Client</Label>
              <Select
                value={clientPartyId}
                onValueChange={(value) => {
                  setClientPartyId(value);
                  setTested(false);
                }}
              >
                <SelectTrigger
                  aria-label="Client party"
                  data-testid="select-connection-client"
                >
                  <SelectValue placeholder="Pick a client…" />
                </SelectTrigger>
                <SelectContent>
                  {clients.map((c) => (
                    <SelectItem key={c.clientPartyId} value={c.clientPartyId}>
                      {c.legalName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedConnector?.configurationFields.map((field) => (
              <div className="space-y-1" key={field.key}>
                <Label htmlFor={`bank-connector-${field.key}`}>
                  {field.label}
                  {field.required ? " *" : ""}
                </Label>
                <Input
                  id={`bank-connector-${field.key}`}
                  type={field.secret ? "password" : "text"}
                  autoComplete="off"
                  value={config[field.key] ?? ""}
                  onChange={(event) => {
                    setConfig((current) => ({
                      ...current,
                      [field.key]: event.target.value,
                    }));
                    setTested(false);
                  }}
                  placeholder={field.placeholder}
                  required={field.required}
                  maxLength={2048}
                />
                <p className="text-xs text-muted-foreground">{field.help}</p>
              </div>
            ))}
            {tested ? (
              <p
                className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-400"
                role="status"
              >
                <CheckCircle2 className="size-4" aria-hidden="true" />
                Test passed. The connection is ready to save.
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                selectedConnector &&
                testConnection.mutate({
                  data: {
                    connectorKey: selectedConnector.key,
                    config,
                  },
                })
              }
              disabled={
                !clientPartyId || !requiredComplete || testConnection.isPending
              }
              data-testid="button-test-connection"
            >
              <TestTube2 className="size-4" aria-hidden="true" />
              {testConnection.isPending ? "Testing…" : "Test connection"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setCreateOpen(false)}
              data-testid="button-cancel-connection"
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                create.mutate({
                  data: {
                    connectorKey,
                    clientPartyId,
                    config,
                  },
                })
              }
              disabled={createDisabled}
              data-testid="button-create-connection"
            >
              {create.isPending ? "Creating…" : "Create connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// Past runs for one connection, newest first — fetched only while the drawer
// is open so a long card never fans out a query per connection.
function ConnectionRuns({ connectionId }: { connectionId: string }) {
  const {
    data: runs,
    isLoading,
    error,
    refetch,
  } = useListStatementSyncRuns(connectionId, {
    query: {
      queryKey: getListStatementSyncRunsQueryKey(connectionId),
      retry: false,
    },
  });
  if (isLoading) return <Skeleton className="h-16" />;
  if (error || !runs)
    return <QueryError thing="the sync history" onRetry={() => refetch()} />;
  if (runs.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`text-runs-empty-${connectionId}`}
      >
        No sync runs yet.
      </p>
    );
  }
  return (
    <ScrollRegion label="Sync runs table">
      <table
        className="w-full text-sm"
        data-testid={`table-connection-runs-${connectionId}`}
      >
        <thead>
          <tr className="border-b text-left text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Started</th>
            <th className="py-2 pr-3 font-medium">Status</th>
            <th className="py-2 pr-3 font-medium text-right">Lines</th>
            <th className="py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {runs.map((r) => (
            <tr key={r.id} data-testid={`row-sync-run-${r.id}`}>
              <td className="py-2 pr-3 whitespace-nowrap">
                {formatDateTime(r.startedAt)}
              </td>
              <td className="py-2 pr-3">
                <span
                  className={pillClasses(SYNC_RUN_TONE[r.status] ?? "slate")}
                >
                  {r.status}
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {r.linesPulled ?? "—"}
              </td>
              <td className="py-2 text-xs text-muted-foreground">
                {r.status === "failed"
                  ? (r.error ?? "Failed")
                  : r.finishedAt
                    ? `Finished ${formatDateTime(r.finishedAt)}`
                    : "Still running"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
