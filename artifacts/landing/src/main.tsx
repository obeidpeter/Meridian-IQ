import { createRoot } from "react-dom/client";
import {
  lazyRoute,
  clearLegacySessionCaches,
  SessionBoundary,
  webSession,
} from "@workspace/web-ui";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import "./index.css";

// Public visitors do not download login, account security or room workflows.
const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
const App =
  pathname === "/login"
    ? lazyRoute(() => import("./App"))
    : pathname === "/accept-invite"
      ? lazyRoute(() =>
          import("./AcceptInvite").then((module) => ({
            default: module.AcceptInvite,
          })),
        )
      : pathname === "/reset-password"
        ? lazyRoute(() =>
            import("./ResetPassword").then((module) => ({
              default: module.ResetPassword,
            })),
          )
        : pathname === "/invoice-room"
          ? lazyRoute(() => import("./InvoiceRoom"))
          : lazyRoute(() => import("./LandingPage"));
const client = new QueryClient({
  mutationCache: new MutationCache(webSession.mutationCacheOptions),
  defaultOptions: {
    queries: {
      retry: (count, error) => {
        const status = (error as { status?: number }).status;
        return !(status && status >= 400 && status < 500) && count < 1;
      },
    },
  },
});
document.title =
  pathname === "/invoice-room"
    ? "Secure Invoice Room | MeridianIQ"
    : pathname === "/accept-invite"
      ? "Accept invitation | MeridianIQ"
      : pathname === "/reset-password"
        ? "Reset password | MeridianIQ"
        : pathname === "/login"
          ? "Sign in | MeridianIQ"
          : "MeridianIQ | Turn every invoice into evidence";
void clearLegacySessionCaches();

// Register the self-healing root service worker. Its only job is to evict any
// stale root-scoped worker left by the app that previously lived at "/", so the
// portal and its sibling apps never get served a cached wrong shell.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        /* best-effort self-heal */
      });
  });
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <SessionBoundary client={client}>
      <App />
    </SessionBoundary>
  </QueryClientProvider>,
);
