import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Authentication is the shared first-party session (see the landing portal at
// "/"): the HttpOnly, origin-wide session cookie is sent automatically with
// every same-origin /api call, so no principal is injected here. A request
// without a valid session gets 401 and the session guard bounces the user to
// the portal to sign in.

// Offline PWA shell (NFR-05). Production only: in dev the worker must never
// serve cached shells (stale bundles hide freshly merged features), so we
// actively unregister any previously installed worker and drop its caches.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    if (import.meta.env.DEV) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
      if ("caches" in window) {
        caches
          .keys()
          .then((keys) =>
            Promise.all(
              keys
                .filter((k) => k.startsWith("meridianiq-"))
                .map((k) => caches.delete(k)),
            ),
          )
          .catch(() => {});
      }
      return;
    }
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker
      .register(swUrl, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        /* offline support is best-effort */
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
