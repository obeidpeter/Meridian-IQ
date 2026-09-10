import {
  useListCollectionAccounts,
  getListCollectionAccountsQueryKey,
  useGetUnmatchedCollections,
  getGetUnmatchedCollectionsQueryKey,
  useCreateCollectionAccount,
  useDeactivateCollectionAccount,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Landmark } from "lucide-react";
import { formatDate, humanize, pillClasses } from "@/lib/format";
import { serverErrorToast } from "@/lib/errors";
import { useToast } from "@/hooks/use-toast";

// ---- Collection accounts ----------------------------------------------------
// Virtual account references provisioned per client: payments sent to a
// reference are observed as settlement evidence automatically. Render-on-
// success — a 403 for roles without scope or a 404 from an older server
// build hides the card entirely.

export function CollectionAccountsCard({
  clientPartyId,
}: {
  clientPartyId: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const params = { clientPartyId };
  const query = useListCollectionAccounts(params, {
    query: {
      queryKey: getListCollectionAccountsQueryKey(params),
      retry: false,
    },
  });
  // Unmatched inbound payments (round 17): firm-wide report filtered to
  // THIS client's accounts — money arrived on a reference and bound to no
  // invoice. Render-on-success like the list itself.
  const { data: unmatched } = useGetUnmatchedCollections({
    query: { queryKey: getGetUnmatchedCollectionsQueryKey(), retry: false },
  });
  const unmatchedRows = (unmatched?.accounts ?? []).filter(
    (a) => a.clientPartyId === clientPartyId,
  );
  const create = useCreateCollectionAccount();
  const deactivate = useDeactivateCollectionAccount();
  if (!query.isSuccess) return null;
  const accounts = query.data ?? [];

  // Prefix key: every param variant of the list goes stale together.
  const refresh = () =>
    void queryClient.invalidateQueries({
      queryKey: getListCollectionAccountsQueryKey(),
    });

  const handleCreate = () => {
    create.mutate(
      { data: { clientPartyId } },
      {
        onSuccess: (account) => {
          refresh();
          toast({
            title: "Collection account provisioned",
            description: `Reference ${account.accountReference} now observes inbound payments as settlements.`,
          });
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not provision a collection account",
            fallback: "Try again.",
          }),
      },
    );
  };

  const handleDeactivate = (id: string) => {
    deactivate.mutate(
      { id },
      {
        onSuccess: () => {
          refresh();
          toast({
            title: "Collection account deactivated",
            description:
              "Inbound payments on its reference stop being recorded.",
          });
        },
        onError: (e) =>
          serverErrorToast(toast, e, {
            title: "Could not deactivate the account",
            fallback: "Try again.",
          }),
      },
    );
  };

  return (
    <Card data-testid="card-collection-accounts">
      <CardHeader className="flex-row items-center justify-between space-y-0 gap-3">
        <CardTitle className="flex items-center gap-2.5 text-base">
          <span className="mi-card-icon">
            <Landmark aria-hidden="true" />
          </span>
          Collection accounts
        </CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={handleCreate}
          disabled={create.isPending}
          data-testid="button-create-collection-account"
        >
          {create.isPending ? "Provisioning…" : "Provision collection account"}
        </Button>
      </CardHeader>
      <CardContent>
        {accounts.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-no-collection-accounts"
          >
            No collection accounts yet — provision one and payments sent to its
            reference are observed as settlements automatically.
          </p>
        ) : (
          <div className="divide-y">
            {accounts.map((a) => (
              <div
                key={a.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                data-testid={`row-collection-account-${a.id}`}
              >
                <div className="min-w-0">
                  <p className="font-mono text-xs">{a.accountReference}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {a.label ?? humanize(a.provider)}
                  </p>
                </div>
                <span className="flex items-center gap-2 shrink-0">
                  <span className={pillClasses(a.active ? "emerald" : "slate")}>
                    {a.active ? "Active" : "Inactive"}
                  </span>
                  {a.active && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeactivate(a.id)}
                      disabled={deactivate.isPending}
                      data-testid={`button-deactivate-account-${a.id}`}
                    >
                      Deactivate
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
        {unmatchedRows.length > 0 && (
          <div
            className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
            data-testid="unmatched-collections-advisory"
          >
            {unmatchedRows.map((r) => (
              <p key={r.accountId} data-testid={`unmatched-${r.accountId}`}>
                {r.count} inbound payment{r.count === 1 ? "" : "s"} on{" "}
                <span className="font-mono text-xs">{r.accountReference}</span>{" "}
                (last {formatDate(r.lastSeen)}) matched no invoice — amounts are
                never recorded for unmatched payments; reconcile against the
                provider statement.
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
