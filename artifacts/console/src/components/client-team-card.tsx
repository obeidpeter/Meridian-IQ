import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetClientAssignmentsQueryKey,
  getGetPortfolioQueryKey,
  getListFirmTeamQueryKey,
  useGetClientAssignments,
  useListFirmTeam,
  useReplaceClientAssignments,
} from "@workspace/api-client-react";
import { Link } from "wouter";
import { UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { roleLabel } from "@/components/capability-gate";
import { userErrorMessage } from "@/lib/errors";
import { inviteClientLoginHref } from "@/lib/invitations";

/**
 * Who looks after this client (architecture.md D12). Everyone in the firm
 * reads the list; a firm admin edits it. Assignment narrows the portfolio's
 * default "My clients" view — it never changes who may open the client.
 */
export function ClientTeamCard({
  clientPartyId,
  canAssign,
}: {
  clientPartyId: string;
  canAssign: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const assignments = useGetClientAssignments(clientPartyId, {
    query: { queryKey: getGetClientAssignmentsQueryKey(clientPartyId) },
  });
  const team = useListFirmTeam({
    query: { enabled: canAssign, queryKey: getListFirmTeamQueryKey() },
  });
  const replace = useReplaceClientAssignments();
  const [selected, setSelected] = useState<Set<string> | null>(null);

  const current = new Set(
    (assignments.data?.assignees ?? []).map((a) => a.userId),
  );
  // Editing starts from the saved set and resets whenever the server answers.
  useEffect(() => {
    setSelected(null);
  }, [assignments.data]);
  const draft = selected ?? current;
  const dirty =
    draft.size !== current.size || [...draft].some((id) => !current.has(id));
  const staff = (team.data ?? []).filter(
    (m) => m.role === "firm_admin" || m.role === "firm_staff",
  );

  const toggle = (userId: string, on: boolean) => {
    const next = new Set(draft);
    if (on) next.add(userId);
    else next.delete(userId);
    setSelected(next);
  };

  const save = () => {
    if (!assignments.data) return;
    replace.mutate(
      {
        id: clientPartyId,
        data: {
          userIds: [...draft],
          expectedVersion: assignments.data.version,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Assignments saved" });
          queryClient.invalidateQueries({
            queryKey: getGetClientAssignmentsQueryKey(clientPartyId),
          });
          queryClient.invalidateQueries({
            queryKey: getGetPortfolioQueryKey(),
          });
        },
        onError: (e) => {
          void assignments.refetch();
          setSelected(null);
          toast({
            title: "Could not save assignments",
            description: userErrorMessage(e),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Card data-testid="card-client-team">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2.5 text-base">
            <span className="mi-card-icon">
              <Users aria-hidden="true" />
            </span>
            Team
          </CardTitle>
          {canAssign && (
            <Link
              href={inviteClientLoginHref(clientPartyId)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline"
              data-testid="link-invite-client-login"
            >
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Invite a client user
            </Link>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Who looks after this client. Everyone in the firm can still open it;
          assignment only shapes each person&rsquo;s &ldquo;My clients&rdquo;
          view.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {assignments.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : assignments.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Could not load the team for this client.
          </p>
        ) : canAssign ? (
          <>
            {staff.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No firm members to assign yet.
              </p>
            ) : (
              <ul className="space-y-2" aria-label="Firm members">
                {staff.map((m) => {
                  const inputId = `assignee-${m.userId}`;
                  return (
                    <li key={m.userId} className="flex items-center gap-3">
                      <Checkbox
                        id={inputId}
                        checked={draft.has(m.userId)}
                        onCheckedChange={(v) => toggle(m.userId, v === true)}
                        data-testid={`checkbox-assignee-${m.userId}`}
                      />
                      <label htmlFor={inputId} className="min-w-0 text-sm">
                        <span className="font-medium">
                          {m.fullName ?? m.email ?? m.userId}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {roleLabel(m.role)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {current.size === 0
                  ? "Unassigned — visible to the whole firm."
                  : `${current.size} assigned`}
              </p>
              <Button
                size="sm"
                onClick={save}
                disabled={!dirty || replace.isPending}
                data-testid="button-save-assignments"
              >
                {replace.isPending ? "Saving…" : "Save changes"}
              </Button>
            </div>
          </>
        ) : current.size === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="text-client-unassigned"
          >
            Unassigned — visible to the whole firm.
          </p>
        ) : (
          <ul className="space-y-1.5" aria-label="Assigned team members">
            {(assignments.data?.assignees ?? []).map((a) => (
              <li
                key={a.userId}
                className="text-sm"
                data-testid={`text-assignee-${a.userId}`}
              >
                <span className="font-medium">
                  {a.fullName ?? a.email ?? a.userId}
                </span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {roleLabel(a.role)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
