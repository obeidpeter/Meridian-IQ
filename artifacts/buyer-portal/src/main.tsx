import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// Dev principal — the buyer portal serves a buyer-side finance user that a
// real session would resolve from a Clerk-verified membership. Zenith Retail
// Group's finance officer responds to confirmation requests, flags payments,
// and reviews supplier VAT exposure. Buyer principals carry a buyer party
// binding instead of a firm binding.
const BUYER_HEADERS: Record<string, string> = {
  "x-mock-role": "buyer_user",
  "x-mock-user": "b0000001-0000-4000-8000-0000000000d1",
  "x-mock-buyer-party": "55555555-5555-4555-8555-555555555555",
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
  for (const [key, value] of Object.entries(BUYER_HEADERS)) {
    headers.set(key, value);
  }
  return originalFetch(input, { ...init, headers });
};

createRoot(document.getElementById("root")!).render(<App />);
