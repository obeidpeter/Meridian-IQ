import type { ReactNode } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { FileCheck2, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorStatus } from "@/lib/errors";

// Authentication uses the origin-wide session cookie set by the portal login.
// This app serves SME client and firm users.
const ALLOWED = ["firm_admin", "firm_staff", "client_user"];
const PORTAL = "/login";

function formatRole(role: string) {
  return role.replaceAll("_", " ");
}

function BrandSplash({
  title,
  description,
  icon,
  children,
  testId,
}: {
  title: string;
  description: ReactNode;
  icon: ReactNode;
  children?: ReactNode;
  testId?: string;
}) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-muted/40 px-5 py-28 text-foreground">
      <header className="absolute inset-x-0 top-0 border-b border-border bg-card/95">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-5 sm:px-8">
          <span className="grid size-9 place-items-center rounded-lg bg-[#0a3332] text-[#d7f46b] shadow-sm">
            <FileCheck2 className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-extrabold leading-none">MeridianIQ</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              Compliance workspace
            </p>
          </div>
        </div>
      </header>

      <section
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center shadow-sm sm:p-8"
        data-testid={testId}
      >
        <div className="mx-auto grid size-12 place-items-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </div>
        <h1 className="mt-5 text-xl font-bold sm:text-2xl">{title}</h1>
        <div className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          {description}
        </div>
        {children ? (
          <div className="mt-6 flex justify-center">{children}</div>
        ) : null}
      </section>
    </main>
  );
}

export function RequireSession({ children }: { children: ReactNode }) {
  const {
    data: me,
    isLoading,
    isError,
    error,
    refetch,
  } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  if (isLoading) {
    return (
      <BrandSplash
        title="Opening your workspace"
        description="Verifying your secure MeridianIQ session."
        icon={<Spinner className="size-6 text-primary" aria-hidden="true" />}
      >
        <span className="sr-only" role="status">
          Checking your session
        </span>
      </BrandSplash>
    );
  }

  if (isError && errorStatus(error) !== 401) {
    return (
      <BrandSplash
        title="MeridianIQ is temporarily unavailable"
        description="We could not reach the service. Check your connection, then try again."
        icon={<WifiOff className="size-6" aria-hidden="true" />}
      >
        <Button
          variant="outline"
          onClick={() => refetch()}
          data-testid="button-retry-session"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </Button>
      </BrandSplash>
    );
  }

  if (isError || !me) {
    window.location.href = PORTAL;
    return null;
  }

  if (!ALLOWED.includes(me.role)) {
    return (
      <BrandSplash
        title="Wrong workspace"
        description={
          <>
            You are signed in as{" "}
            <span className="font-semibold text-foreground">
              {formatRole(me.role)}
            </span>
            . Compliance is available to SME and firm accounts.
          </>
        }
        icon={<ShieldAlert className="size-6" aria-hidden="true" />}
        testId="card-wrong-role"
      >
        <Button onClick={() => (window.location.href = PORTAL)}>
          Back to the MeridianIQ portal
        </Button>
      </BrandSplash>
    );
  }

  return <>{children}</>;
}
