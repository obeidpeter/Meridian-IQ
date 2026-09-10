// The landing app's route switch. The /login portal itself lives in
// src/portal (R126); the four lazy route boundaries and the query client
// stay here so the bundle budgets measure the same chunks.

import { useEffect } from "react";
import {
  QueryClient,
  MutationCache,
  QueryClientProvider,
} from "@tanstack/react-query";
import { lazyRoute, SessionBoundary, webSession } from "@workspace/web-ui";
import "@/auth.css";
import { Portal } from "@/portal";

const LandingPage = lazyRoute(() => import("@/LandingPage"));
const AcceptInvite = lazyRoute(() =>
  import("@/AcceptInvite").then((module) => ({ default: module.AcceptInvite })),
);
const ResetPassword = lazyRoute(() =>
  import("@/ResetPassword").then((module) => ({
    default: module.ResetPassword,
  })),
);
const InvoiceRoom = lazyRoute(() => import("@/InvoiceRoom"));

const queryClient = new QueryClient({
  mutationCache: new MutationCache(webSession.mutationCacheOptions),
  defaultOptions: {
    queries: {
      retry: (count, err: unknown) => {
        const status = (err as { status?: number })?.status;
        if (status && status >= 400 && status < 500) return false;
        return count < 1;
      },
    },
  },
});

export default function App() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const pageTitle =
    pathname === "/invoice-room"
      ? "Secure Invoice Room | Valo"
      : pathname === "/login"
        ? "Sign in | Valo"
        : pathname === "/reset-password"
          ? "Reset password | Valo"
          : pathname === "/accept-invite"
            ? "Accept invitation | Valo"
            : "Valo | Turn every invoice into evidence";

  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);

  if (pathname === "/accept-invite") {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionBoundary client={queryClient}>
          <AcceptInvite />
        </SessionBoundary>
      </QueryClientProvider>
    );
  }

  if (pathname === "/reset-password") {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionBoundary client={queryClient}>
          <ResetPassword />
        </SessionBoundary>
      </QueryClientProvider>
    );
  }

  if (pathname === "/invoice-room") {
    return (
      <QueryClientProvider client={queryClient}>
        <SessionBoundary client={queryClient}>
          <InvoiceRoom />
        </SessionBoundary>
      </QueryClientProvider>
    );
  }

  if (pathname !== "/login") {
    return <LandingPage />;
  }

  return (
    <QueryClientProvider client={queryClient}>
      <SessionBoundary client={queryClient}>
        <Portal />
      </SessionBoundary>
    </QueryClientProvider>
  );
}
