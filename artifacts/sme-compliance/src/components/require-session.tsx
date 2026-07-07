import type { ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Loader2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// Shared session gate. Authentication is the origin-wide session cookie set by
// the portal login at "/"; an unauthenticated visitor is bounced there. This
// app serves SME client/firm users.
const ALLOWED = ["firm_admin", "firm_staff", "client_user"];

const PORTAL = "/";

export function RequireSession({ children }: { children: ReactNode }) {
  const { data: me, isLoading, isError } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background">
        <span className="text-lg font-semibold tracking-tight text-primary">
          MeridianIQ
        </span>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !me) {
    // Not signed in (or the session expired): send them to the portal to log in.
    window.location.href = PORTAL;
    return null;
  }

  if (!ALLOWED.includes(me.role)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full text-center border rounded-xl p-8 space-y-4 bg-card">
          <ShieldAlert className="w-10 h-10 mx-auto text-amber-500" />
          <h1 className="text-xl font-semibold">Wrong workspace</h1>
          <p className="text-sm text-muted-foreground">
            You're signed in as <span className="font-medium">{me.role}</span>.
            The Compliance app is for SME and firm users. Head back to the portal
            to open the right workspace or switch accounts.
          </p>
          <Button onClick={() => (window.location.href = PORTAL)}>
            Back to the MeridianIQ portal
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
