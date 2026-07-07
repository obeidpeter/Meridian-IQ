import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Dev principal — the seeded demo SME's firm_staff user (Adaeze Foods retainer).
// In production a real session replaces these; here we inject the demo tenant
// identity so every API call resolves to the same client without a login step.
const DEV_HEADERS: Record<string, string> = {
  "x-mock-role": "firm_staff",
  "x-mock-user": "44444444-4444-4444-8444-444444444444",
  "x-mock-firm": "11111111-1111-4111-8111-111111111111",
  "x-mock-client-party": "22222222-2222-4222-8222-222222222222",
};

const originalFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (!url.includes("/api/")) return originalFetch(input, init);
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  for (const [key, value] of Object.entries(DEV_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return originalFetch(input, { ...init, headers });
};

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
