import { useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetClientPortfolioQueryKey,
  getGetPartyQueryKey,
  getGetPortfolioQueryKey,
  getGetWorkspaceTodayQueryKey,
  getListPartiesQueryKey,
  useGetMe,
  useGetParty,
  useUpdateParty,
} from "@workspace/api-client-react";
import {
  BusinessDetailsForm,
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
  const { id = "" } = useParams<{ id: string }>();
  const me = useGetMe();
  const canEdit = Boolean(
    me.data &&
    ["firm_admin", "firm_staff"].includes(me.data.role) &&
    me.data.capabilities.includes("party.write") &&
    me.data.capabilities.includes("party.read"),
  );
  const party = useGetParty(id, {
    query: {
      queryKey: getGetPartyQueryKey(id),
      enabled: canEdit && !me.error && Boolean(id),
    },
  });
  const update = useUpdateParty();
  const client = useQueryClient();
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  async function save(patch: BusinessDetailsPatch) {
    if (!canEdit || me.error || !id)
      throw new Error("This account cannot edit these business details.");
    try {
      await client.cancelQueries({ queryKey: getGetPartyQueryKey(id) });
      const updated = await update.mutateAsync({ id, data: patch });
      await client.cancelQueries({ queryKey: getGetPartyQueryKey(id) });
      client.setQueryData(getGetPartyQueryKey(id), updated);
      for (const queryKey of [
        getGetWorkspaceTodayQueryKey(),
        getGetPortfolioQueryKey(),
        getGetClientPortfolioQueryKey(id),
        getListPartiesQueryKey(),
      ]) {
        void client.invalidateQueries({ queryKey });
      }
      return updated;
    } catch (error) {
      // R113: a 409 is another save landing first. Refetch so the form can
      // show the newer saved values beside the unsaved ones; the message
      // below is the server's own.
      if (errorStatus(error) === 409) void party.refetch();
      throw new Error(
        serverErrorMessage(error) ??
          "Business details could not be saved. Please try again.",
      );
    }
  }

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        title="Business details"
        description={canEdit ? party.data?.legalName : undefined}
        actions={
          <Button asChild variant="outline">
            <Link href={id && canEdit ? `/clients/${id}` : "/"}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to client
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
          This page requires a firm account with permission to edit business
          details.
        </p>
      ) : !id ? (
        <p role="alert">No client business was selected.</p>
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
        <p role="alert">
          These details do not belong to the selected client business.
        </p>
      ) : (
        <>
          {party.error ? (
            <QueryError
              thing="the latest business details"
              onRetry={() => void party.refetch()}
            />
          ) : null}
          <BusinessDetailsForm
            party={party.data}
            onSave={save}
            onDirtyChange={setDirty}
            disabledReason={
              me.error
                ? "Account permissions could not be refreshed. Retry before saving."
                : party.data.mergedIntoId
                  ? "This business record has been merged and can no longer be edited here."
                  : null
            }
          />
        </>
      )}
    </div>
  );
}
