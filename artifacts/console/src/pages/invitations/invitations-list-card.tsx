import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { roleLabel } from "@/components/capability-gate";
import { ScrollRegion } from "@/components/scroll-region";
import { formatDateTime, pillClasses } from "@/lib/format";
import {
  invitationStatusTone,
  invitationStatusLabel,
  effectiveInvitationStatus,
} from "@/lib/invitations";
import { Mail } from "lucide-react";
import type { InvitationsState } from "./use-invitations";

// The invitations table with its loading, error and empty states.
export function InvitationsListCard({ state }: { state: InvitationsState }) {
  const {
    isLoading,
    error,
    refetch,
    invitations,
    isOperator,
    clientNameById,
    firmNameById,
    revoke,
    revokingId,
    setRevokeTarget,
  } = state;
  return (
    <Card data-testid="card-invitations">
      <CardHeader>
        <CardTitle className="text-base">Invitations</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3" data-testid="loading-invitations">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : error ? (
          <QueryError thing="invitations" onRetry={() => refetch()} />
        ) : (invitations ?? []).length === 0 ? (
          <EmptyState
            icon={Mail}
            title="No invitations yet"
            description="Invite a teammate or client above — pending invitations appear here."
            className="py-10 px-0"
          />
        ) : (
          <ScrollRegion label="Invitations table">
            <table
              className="w-full border-collapse text-sm"
              data-testid="table-invitations"
            >
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Email
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Role
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Client
                  </th>
                  {isOperator && (
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Firm
                    </th>
                  )}
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Created
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    Expires
                  </th>
                  <th scope="col" className="py-2 font-medium text-right">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(invitations ?? []).map((inv) => (
                  <tr key={inv.id} data-testid={`row-invitation-${inv.id}`}>
                    <td className="py-2.5 pr-3 font-medium">{inv.email}</td>
                    <td className="py-2.5 pr-3">{roleLabel(inv.role)}</td>
                    <td
                      className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap"
                      data-testid={`client-${inv.id}`}
                    >
                      {inv.clientPartyId
                        ? (clientNameById.get(inv.clientPartyId) ?? (
                            <span className="font-mono text-xs">
                              {inv.clientPartyId.slice(0, 8)}
                            </span>
                          ))
                        : "—"}
                    </td>
                    {isOperator && (
                      <td
                        className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap"
                        data-testid={`firm-${inv.id}`}
                      >
                        {firmNameById.get(inv.firmId) ?? (
                          <span className="font-mono text-xs">
                            {inv.firmId.slice(0, 8)}
                          </span>
                        )}
                      </td>
                    )}
                    <td className="py-2.5 pr-3">
                      <span
                        className={pillClasses(
                          invitationStatusTone(effectiveInvitationStatus(inv)),
                        )}
                        data-testid={`status-${inv.id}`}
                      >
                        {invitationStatusLabel(effectiveInvitationStatus(inv))}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                      {formatDateTime(inv.createdAt)}
                    </td>
                    <td className="py-2.5 pr-3 text-muted-foreground whitespace-nowrap">
                      {formatDateTime(inv.expiresAt)}
                    </td>
                    <td className="py-2.5 text-right">
                      {inv.status === "pending" && (
                        <div className="flex justify-end gap-1">
                          {/* Operators don't issue client invites (the
                                role picker excludes client_user), so no
                                replace shortcut on those rows for them. */}
                          {(!isOperator || inv.role !== "client_user") && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={
                                revoke.isPending && revokingId === inv.id
                              }
                              onClick={() =>
                                setRevokeTarget({
                                  invitation: inv,
                                  replace: true,
                                })
                              }
                              data-testid={`button-new-link-${inv.id}`}
                            >
                              New link
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={revoke.isPending && revokingId === inv.id}
                            onClick={() =>
                              setRevokeTarget({
                                invitation: inv,
                                replace: false,
                              })
                            }
                            data-testid={`button-revoke-${inv.id}`}
                          >
                            {revoke.isPending && revokingId === inv.id
                              ? "Revoking…"
                              : "Revoke"}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </CardContent>
    </Card>
  );
}
