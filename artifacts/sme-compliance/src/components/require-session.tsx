import type { ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorStatus } from "@/lib/errors";

// Shared session gate. Authentication is the origin-wide session cookie set by
// the portal login at "/"; an unauthenticated visitor is bounced there. This
// app serves SME client/firm users.
const ALLOWED = ["firm_admin", "firm_staff", "client_user"];

const PORTAL = "/";

function BrandSplash({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6 text-center">
      <span className="text-2xl font-bold text-primary">MeridianIQ</span>
      {children}
    </div>
  );
}

export function RequireSession({ children }: { children: ReactNode }) {
  const { data: me, isLoading, isError, error, refetch } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  if (isLoading) {
    return (
      <BrandSplash>
        <Spinner className="size-6 text-muted-foreground" />
      </BrandSplash>
    );
  }

  if (isError && errorStatus(error) !== 401) {
    // A transient failure (network blip, 5xx) is not a missing session —
    // offer a retry instead of bouncing a signed-in user to the portal.
    return (
      <BrandSplash>
        <p className="text-sm text-muted-foreground max-w-sm">
          Can't reach MeridianIQ right now. Check your connection and try
          again.
        </p>
        <Button
          variant="outline"
          onClick={() => refetch()}
          data-testid="button-retry-session"
        >
          Retry
        </Button>
      </BrandSplash>
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
          <ShieldAlert className="w-10 h-10 mx-auto text-amber-500" aria-hidden="true" />
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
