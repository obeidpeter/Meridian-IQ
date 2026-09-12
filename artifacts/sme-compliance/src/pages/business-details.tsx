import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPartyQueryKey,
  getGetWorkspaceTodayQueryKey,
  getListPartiesQueryKey,
  useGetMe,
  useGetParty,
  useUpdateParty,
} from "@workspace/api-client-react";
import {
  BusinessDetailsForm,
  useBusinessDetailsSaveScope,
  RouteLoading,
  WorkspaceHeader,
  type BusinessDetailsPatch,
} from "@workspace/web-ui";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueryError } from "@/components/query-error";
import { usePageTitle } from "@/hooks/use-page-title";
import { errorStatus, serverErrorMessage } from "@/lib/errors";

export default function BusinessDetails() {
  usePageTitle("Business details");
  const me = useGetMe();
  // Never take the client party from a route, query string or a form field.
  const id =
    me.data?.role === "client_user" ? (me.data.clientPartyId ?? "") : "";
  const canEdit = Boolean(id && me.data?.capabilities.includes("party.read"));
  const party = useGetParty(id, {
    query: { queryKey: getGetPartyQueryKey(id), enabled: canEdit && !me.error },
  });
  const update = useUpdateParty();
  const client = useQueryClient();
  const scope = useBusinessDetailsSaveScope(
    me.data,
    id,
    canEdit,
    me.error,
    party.data,
  );

  async function save(patch: BusinessDetailsPatch) {
    if (!canEdit || me.error || !id)
      throw new Error("No editable business is linked to this account.");
    try {
      await client.cancelQueries({ queryKey: getGetPartyQueryKey(id) });
      scope.assertCurrent();
      const updated = await update.mutateAsync({ id, data: patch });
      scope.assertCurrent();
      if (updated.id !== id || updated.type !== "client_business")
        throw new Error(
          "The saved business record did not match this business.",
        );
      await client.cancelQueries({ queryKey: getGetPartyQueryKey(id) });
      scope.assertCurrent();
      client.setQueryData(getGetPartyQueryKey(id), updated);
      void client.invalidateQueries({
        queryKey: getGetWorkspaceTodayQueryKey(),
      });
      void client.invalidateQueries({ queryKey: getListPartiesQueryKey() });
      return updated;
    } catch (error) {
      // R113: a 409 is another save landing first. Refetch so the form can
      // show the newer saved values beside the unsaved ones; the message
      // below is the server's own.
      if (scope.isCurrent() && errorStatus(error) === 409) void party.refetch();
      throw new Error(serverErrorMessage(error));
    }
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        title="Business details"
        description={canEdit ? party.data?.legalName : undefined}
        actions={
          <Button asChild variant="outline">
            <Link href="/">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to Today
            </Link>
          </Button>
        }
      />
      {me.error && me.data ? (
        <QueryError
          thing="your account permissions"
          onRetry={() => void me.refetch()}
        />
      ) : null}
      {me.error && !me.data ? (
        <QueryError thing="your account" onRetry={() => void me.refetch()} />
      ) : !me.data ? (
        <RouteLoading />
      ) : !canEdit ? (
        <p role="alert">
          No editable client business is linked to this account.
        </p>
      ) : !party.data ? (
        party.isLoading ? (
          <RouteLoading />
        ) : (
          <QueryError
            thing="business details"
            onRetry={() => void party.refetch()}
          />
        )
      ) : party.data.id !== id || party.data.type !== "client_business" ? (
        <p role="alert">These details do not belong to your business.</p>
      ) : (
        <>
          {party.error ? (
            <QueryError
              thing="the latest business details"
              onRetry={() => void party.refetch()}
            />
          ) : null}
          <BusinessDetailsForm
            key={scope.key}
            party={party.data}
            onSave={save}
            disabledReason={
              me.error
                ? "Account permissions could not be refreshed. Retry before saving."
                : party.data.mergedIntoId
                  ? "This business record has been merged. Ask your firm to review your business access."
                  : null
            }
          />
        </>
      )}
    </div>
  );
}
