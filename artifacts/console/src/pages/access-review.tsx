import { useQueryClient } from "@tanstack/react-query";
import {
  getGetAccessRegisterQueryKey,
  useAttestAccessRegister,
  useGetAccessRegister,
  type AccessRegisterMember,
} from "@workspace/api-client-react";
import { Download, ShieldCheck, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { QueryError } from "@/components/query-error";
import { ScrollRegion } from "@/components/scroll-region";
import { roleLabel } from "@/components/capability-gate";
import { usePageTitle } from "@/hooks/use-page-title";
import { useToast } from "@/hooks/use-toast";
import { formatDate } from "@/lib/format";
import { serverErrorMessage } from "@/lib/errors";
import { Metric, MetricStrip, WorkspaceHeader } from "@workspace/web-ui";

/**
 * Lightweight access review (architecture.md D14): who holds access to this
 * firm, since when, when they last signed in, whether MFA is on, and which
 * clients they look after — then one button to attest the register as
 * reviewed. The attestation goes on the audit chain against the register's
 * hash; if anything changed since the page loaded, the server refuses and
 * the page reloads the current register.
 */

export function memberFlags(m: AccessRegisterMember): string[] {
  const flags: string[] = [];
  if (!m.mfaEnabled && m.role !== "client_user") flags.push("No MFA");
  if (!m.lastSignInAt) flags.push("Never signed in");
  return flags;
}

export function AccessReview() {
  usePageTitle("Access review");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError, refetch } = useGetAccessRegister({
    query: { queryKey: getGetAccessRegisterQueryKey() },
  });
  const attest = useAttestAccessRegister();

  const submit = () => {
    if (!data) return;
    attest.mutate(
      { data: { hash: data.hash } },
      {
        onSuccess: () => {
          toast({ title: "Access register attested" });
          queryClient.invalidateQueries({
            queryKey: getGetAccessRegisterQueryKey(),
          });
        },
        onError: (e) => {
          toast({
            title: "Could not attest",
            description: serverErrorMessage(e),
            variant: "destructive",
          });
          // A stale hash means the register moved: show the current one.
          queryClient.invalidateQueries({
            queryKey: getGetAccessRegisterQueryKey(),
          });
        },
      },
    );
  };

  const members = data?.members ?? [];
  const flagged = members.filter((m) => memberFlags(m).length > 0).length;
  const lastAttestation = data?.lastAttestation ?? null;
  const upToDate = !!lastAttestation && lastAttestation.hash === data?.hash;

  return (
    <div className="space-y-6">
      <WorkspaceHeader
        eyebrow="Team & access"
        title="Access review"
        description="Everyone who can open this firm's workspaces, what they can do, and when they last did. Review it, then attest it — the attestation is recorded on the audit chain."
        actions={
          <>
            <Button asChild variant="outline">
              <a
                href="/api/console/access-register/csv"
                data-testid="link-download-access-register"
              >
                <Download className="size-4" aria-hidden="true" />
                Download CSV
              </a>
            </Button>
            <Button
              onClick={submit}
              disabled={!data || attest.isPending || upToDate}
              data-testid="button-attest-access"
            >
              <ShieldCheck className="size-4" aria-hidden="true" />
              {attest.isPending
                ? "Recording…"
                : upToDate
                  ? "Attested — nothing changed"
                  : "Attest as reviewed"}
            </Button>
          </>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading the register…</p>
      ) : isError || !data ? (
        <QueryError thing="the access register" onRetry={() => refetch()} />
      ) : (
        <>
          <MetricStrip label="Access summary">
            <Metric
              label="Members"
              value={String(members.length)}
              detail="Hold access to this firm"
              icon={<UserCheck className="size-4" aria-hidden="true" />}
            />
            <Metric
              label="Need attention"
              value={String(flagged)}
              detail="No MFA or never signed in"
              tone={flagged > 0 ? "warning" : "positive"}
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
            />
            <Metric
              label="Last attested"
              value={
                lastAttestation
                  ? formatDate(lastAttestation.attestedAt)
                  : "Never"
              }
              detail={
                lastAttestation
                  ? `by ${lastAttestation.byName ?? "a firm admin"} · ${lastAttestation.memberCount} members${upToDate ? "" : " · register has changed since"}`
                  : "No review recorded yet"
              }
              tone={
                upToDate ? "positive" : lastAttestation ? "warning" : "default"
              }
              icon={<ShieldCheck className="size-4" aria-hidden="true" />}
              testId="stat-last-attested"
            />
          </MetricStrip>

          <Card data-testid="card-access-register">
            <CardHeader>
              <CardTitle className="flex items-center gap-2.5 text-base">
                <span className="mi-card-icon">
                  <UserCheck aria-hidden="true" />
                </span>
                Access register
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Generated {formatDate(data.generatedAt)}. Client assignments
                come from the Team card on each client page.
              </p>
            </CardHeader>
            <CardContent className="px-0 sm:px-6">
              <ScrollRegion label="Access register table">
                <table className="w-full min-w-[56rem] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b text-xs font-bold uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2">Member</th>
                      <th className="px-3 py-2">Role</th>
                      <th className="px-3 py-2">Since</th>
                      <th className="px-3 py-2">Last sign-in</th>
                      <th className="px-3 py-2">MFA</th>
                      <th className="px-3 py-2">Assigned clients</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => {
                      const flags = memberFlags(m);
                      return (
                        <tr
                          key={m.userId}
                          className="border-b last:border-0"
                          data-testid={`row-member-${m.userId}`}
                        >
                          <td className="px-3 py-2">
                            <p className="font-medium">
                              {m.fullName ?? m.email ?? m.userId}
                            </p>
                            {m.email && m.fullName ? (
                              <p className="text-xs text-muted-foreground">
                                {m.email}
                              </p>
                            ) : null}
                            {flags.length > 0 ? (
                              <p
                                className="mt-1 text-xs font-semibold text-[var(--mi-warning)]"
                                data-testid={`text-member-flags-${m.userId}`}
                              >
                                {flags.join(" · ")}
                              </p>
                            ) : null}
                          </td>
                          <td className="px-3 py-2">{roleLabel(m.role)}</td>
                          <td className="px-3 py-2 tabular-nums">
                            {formatDate(m.since)}
                          </td>
                          <td className="px-3 py-2 tabular-nums">
                            {m.lastSignInAt
                              ? formatDate(m.lastSignInAt)
                              : "Never"}
                          </td>
                          <td className="px-3 py-2">
                            {m.mfaEnabled ? "On" : "Off"}
                          </td>
                          <td
                            className="px-3 py-2"
                            data-testid={`text-member-clients-${m.userId}`}
                          >
                            {m.assignedClients.length > 0
                              ? m.assignedClients.join(", ")
                              : m.role === "client_user"
                                ? "—"
                                : "Unassigned"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollRegion>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
