import { ReactNode } from "react";
import { Link } from "wouter";
import { useGetMe } from "@workspace/api-client-react";
import type { Me } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PORTAL_URL } from "@/components/require-session";
import { Lock } from "lucide-react";

// Console pages map 1:1 to RBAC capabilities (see modules/auth/rbac.ts on the
// server). The nav only offers pages the principal can use; this gate covers
// direct URL hits so a wrong-role visitor gets an explanation instead of a
// broken page full of 403s. RoleGate is the same idea for the few surfaces
// the server gates on an EXPLICIT role rather than a capability (the
// firm-admin integration controls — routes/integrations.ts firmAdminScope).

export function roleLabel(role: string | undefined): string {
  return (
    {
      firm_admin: "Firm admin",
      firm_staff: "Firm staff",
      client_user: "Client user",
      operator: "Operator",
      buyer_user: "Buyer",
      auditor: "Auditor",
    }[role ?? ""] ?? (role || "Unknown role")
  );
}

function AccessDenied({ me, needs }: { me: Me; needs: ReactNode }) {
  return (
    <div className="max-w-lg mx-auto mt-16">
      <Card data-testid="card-access-denied">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <Lock className="w-5 h-5 text-muted-foreground mt-0.5 shrink-0" aria-hidden="true" />
            <div className="space-y-3">
              <div>
                <p className="font-medium">Not available for your account</p>
                <p className="text-sm text-muted-foreground mt-1">
                  You're signed in as{" "}
                  <span className="font-medium text-foreground">
                    {roleLabel(me.role)}
                  </span>
                  {me.email ? ` (${me.email})` : ""}. {needs}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" asChild data-testid="button-console-home">
                  <Link href="/">Console home</Link>
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  asChild
                  data-testid="button-switch-account"
                >
                  <a href={PORTAL_URL}>Switch account</a>
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function CapabilityGate({
  capability,
  children,
}: {
  capability: string;
  children: ReactNode;
}) {
  const { data: me } = useGetMe();
  // RequireSession renders the app only after the session resolves, so me is
  // cached here; guard anyway to avoid a flash on refetches.
  if (!me) return null;
  if (!me.capabilities.includes(capability)) {
    return (
      <AccessDenied
        me={me}
        needs={
          <>
            This page needs an account with the{" "}
            <code className="text-xs">{capability}</code> permission.
          </>
        }
      />
    );
  }
  return <>{children}</>;
}

export function RoleGate({
  role,
  children,
}: {
  role: string;
  children: ReactNode;
}) {
  const { data: me } = useGetMe();
  if (!me) return null;
  if (me.role !== role) {
    return (
      <AccessDenied
        me={me}
        needs={<>This page is only available to the {roleLabel(role)} account.</>}
      />
    );
  }
  return <>{children}</>;
}
