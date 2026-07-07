import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Authentication is the shared first-party session (see the landing portal at
// "/"): the HttpOnly, origin-wide session cookie is sent automatically with
// every same-origin /api call, so no principal is injected here. A request
// without a valid session gets 401 and the session guard bounces the user to
// the portal to sign in.

// Offline PWA shell (NFR-05).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker
      .register(swUrl, { scope: import.meta.env.BASE_URL })
      .catch(() => {
        /* offline support is best-effort */
      });
  });
}

createRoot(document.getElementById("root")!).render(<App />);
