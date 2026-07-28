import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetMe,
  useGetFirmPolicies,
  useUpdateFirmPolicies,
  getGetFirmPoliciesQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { QueryError } from "@/components/query-error";
import { errorStatus, serverErrorMessage } from "@/lib/errors";

// Firm governance policies (contract 0.45.0): today a single switch — the
// maker-checker submission rule. The PUT is firm-admin only, so the card
// mirrors that rule client-side and renders only for firm admins (the
// staff-notification-prefs self-gate pattern) instead of showing a switch
// that can only 403.

export function isFirmAdminRole(role: string | null | undefined): boolean {
  return role === "firm_admin";
}

// What the card renders. "hidden" is reserved for callers the server would
// 403 (not a firm admin — including the server saying so itself while /me
// lags a role change); a TRANSIENT load failure for a legitimate admin is
// "error", never "hidden" — silently removing a policy control because one
// fetch 500'd would read as the feature not existing.
export type GovernanceCardState = "hidden" | "loading" | "error" | "form";

export function governanceCardState(args: {
  firmAdmin: boolean;
  isError: boolean;
  /** HTTP status of the load failure; undefined for a network-level error. */
  errorStatus: number | undefined;
  isSuccess: boolean;
}): GovernanceCardState {
  if (!args.firmAdmin) return "hidden";
  if (args.isError) {
    return args.errorStatus === 403 ? "hidden" : "error";
  }
  return args.isSuccess ? "form" : "loading";
}

export function GovernanceCard() {
  const { data: me } = useGetMe();
  const queryClient = useQueryClient();
  const firmAdmin = isFirmAdminRole(me?.role);
  // No automatic retry: a 403 (role changed underneath us) is a final
  // answer; other failures render the inline error card with its manual
  // retry.
  const policies = useGetFirmPolicies({
    query: {
      queryKey: getGetFirmPoliciesQueryKey(),
      enabled: firmAdmin,
      retry: false,
    },
  });
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateFirmPolicies({
    mutation: {
      onSuccess: (next) => {
        // The server's answer is the truth the switch shows next.
        queryClient.setQueryData(getGetFirmPoliciesQueryKey(), next);
        setError(null);
      },
      onError: (e) =>
        setError(
          serverErrorMessage(e) ?? "Could not update the policy. Try again.",
        ),
    },
  });

  const state = governanceCardState({
    firmAdmin,
    isError: policies.isError,
    errorStatus: errorStatus(policies.error),
    isSuccess: policies.isSuccess,
  });
  if (state === "hidden" || state === "loading") return null;
  if (state === "error") {
    return (
      <Card data-testid="card-governance">
        <CardHeader>
          <CardTitle className="text-base">Governance</CardTitle>
        </CardHeader>
        <CardContent>
          <QueryError
            thing="your firm's governance policies"
            onRetry={() => void policies.refetch()}
          />
        </CardContent>
      </Card>
    );
  }
  if (!policies.isSuccess) return null; // narrows policies.data; unreachable at "form"

  return (
    <Card data-testid="card-governance">
      <CardHeader>
        <CardTitle className="text-base">Governance</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor="policy-submit-approval">Submission approval</Label>
            <p className="text-xs text-muted-foreground">
              Require a second approver before any invoice is submitted for
              stamping. The approver must differ from the submitter —
              maker-checker, enforced server-side.
            </p>
          </div>
          <Switch
            id="policy-submit-approval"
            checked={policies.data.submitApprovalRequired}
            disabled={update.isPending}
            onCheckedChange={(v) =>
              update.mutate({ data: { submitApprovalRequired: v === true } })
            }
            data-testid="switch-submit-approval"
          />
        </div>
        {error && (
          <p
            className="text-sm text-destructive"
            role="alert"
            data-testid="text-governance-error"
          >
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
