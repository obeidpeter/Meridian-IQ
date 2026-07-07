import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Dev principals — the console serves two personas that a real session would
// resolve from a Clerk-verified membership:
//   • firm_admin runs the accountant surfaces (portfolio, onboarding, billing).
//   • operator runs the cross-tenant work queue (no firm binding).
// Operator endpoints (/api/operator/*) require the operator role, so we inject
// role-appropriate headers per request path instead of a single principal.
const FIRM_ADMIN_HEADERS: Record<string, string> = {
  "x-mock-role": "firm_admin",
  "x-mock-user": "44444444-4444-4444-8444-4444444444a0",
  "x-mock-firm": "11111111-1111-4111-8111-111111111111",
};

const OPERATOR_HEADERS: Record<string, string> = {
  "x-mock-role": "operator",
  "x-mock-user": "99999999-9999-4999-8999-999999999999",
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
  const isOperator = url.includes("/api/operator/");
  const principal = isOperator ? OPERATOR_HEADERS : FIRM_ADMIN_HEADERS;
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  // Operator requests must not carry a stale firm header from a prior call.
  headers.delete("x-mock-role");
  headers.delete("x-mock-user");
  headers.delete("x-mock-firm");
  for (const [key, value] of Object.entries(principal)) {
    headers.set(key, value);
  }
  return originalFetch(input, { ...init, headers });
};

createRoot(document.getElementById("root")!).render(<App />);
