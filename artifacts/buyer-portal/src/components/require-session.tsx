import type { ReactNode } from "react";
import { useEffect } from "react";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Building2, RefreshCw, ShieldAlert, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorStatus } from "@/lib/errors";

function goToPortal() {
  window.location.href = "/login";
}

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
          <span className="grid size-9 place-items-center rounded-lg bg-[#0b2545] text-[#66e6f2] shadow-sm">
            <Building2 className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-base font-extrabold leading-none">MeridianIQ</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">
              Buyer portal
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

/**
 * Resolves the buyer principal once. Buyer scoping is then enforced by the
 * server for every page in this workspace.
 */
export function RequireSession({
  allow,
  children,
}: {
  allow: string[];
  children: ReactNode;
}) {
  const {
    data: me,
    isLoading,
    error,
    refetch,
  } = useGetMe({
    query: { queryKey: getGetMeQueryKey(), retry: false },
  });

  const unauthenticated = errorStatus(error) === 401;
  useEffect(() => {
    if (unauthenticated) goToPortal();
  }, [unauthenticated]);

  if (isLoading) {
    return (
      <BrandSplash
        title="Opening your buyer workspace"
        description="Verifying your secure MeridianIQ session."
        icon={<Spinner className="size-6 text-primary" aria-hidden="true" />}
      >
        <span className="sr-only" role="status">
          Loading your session
        </span>
      </BrandSplash>
    );
  }

  if (error && !unauthenticated) {
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

  if (error || !me) {
    return null;
  }

  if (!allow.includes(me.role)) {
    return (
      <BrandSplash
        title="Wrong workspace"
        description={
          <>
            You are signed in as{" "}
            <span className="font-semibold text-foreground">
              {formatRole(me.role)}
            </span>
            . This portal requires a {allow.map(formatRole).join(" or ")}{" "}
            account.
          </>
        }
        icon={<ShieldAlert className="size-6" aria-hidden="true" />}
        testId="card-wrong-workspace"
      >
        <Button onClick={goToPortal} data-testid="button-back-to-portal">
          Back to the MeridianIQ portal
        </Button>
      </BrandSplash>
    );
  }

  return <>{children}</>;
}
