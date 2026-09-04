import type { Principal } from "../modules/auth/rbac";

export interface RequestPattern {
  method: string;
  pattern: RegExp;
}

// Cross-tenant roles are scoped by route-level checks instead of a firm RLS
// context. A missing principal also runs in bypass for public endpoints.
export const BYPASS_ROLES: ReadonlySet<Principal["role"]> = new Set([
  "operator",
  "auditor",
  "bank_user",
  "buyer_user",
]);

export const NO_CONTEXT_PATHS = new Set([
  "/api/healthz",
  "/api/readyz",
  "/api/metrics",
  "/api/internal/sweep",
]);

// These handlers own short transaction scopes around network calls, durable
// queue reservations, or batch items. Adding an entry requires a matching
// posture test and either model rate limiting or an explicit non-model reason.
export const NO_CONTEXT_ROUTES = new Set([
  "POST /api/auth/request-password-reset",
  "POST /api/public/advisory-requests",
  "POST /api/public/usability-events",
  "POST /api/public/access-requests",
  "POST /api/connections/test",
  "POST /api/statement-connections/test",
  "POST /api/clerk/cases",
  "POST /api/clerk/cases/batch",
  "POST /api/clerk/ask",
  "POST /api/clerk/eval/run",
  "POST /api/clerk/catalogue-draft",
  "POST /api/clerk/batches",
  "POST /api/clerk/format-draft",
  "POST /api/clerk/draft-invoice",
  "POST /api/clerk/narration-suggestions",
  "POST /api/clerk/client-import-draft",
  "POST /api/clerk/eval/canary",
  "POST /api/clerk/eval/model-canary",
  "POST /api/clerk/eval/intent",
  "POST /api/clerk/eval/phrasing",
  "POST /api/clerk/eval/retrieval",
  "POST /api/inbound/email",
  "POST /api/inbound/whatsapp",
  "POST /api/statements",
  "POST /api/clerk/cases/bulk-approve",
  "POST /api/billing/payments/confirm",
  "POST /api/collections/inbound",
  "POST /api/public/invoice-room/exchange",
  "POST /api/public/invoice-room/otp",
  "POST /api/public/invoice-room/verify",
  "POST /api/public/invoice-room/respond",
  "POST /api/public/invoice-room/payment-reports",
  "POST /api/public/invoice-room/payment-link",
  "POST /api/public/invoice-room/claim",
  "POST /api/invoice-room/payments/confirm",
  "POST /api/billing/payments",
  "POST /api/collection-accounts",
  "POST /api/clerk/action-proposals/execute",
  "POST /api/clerk/plan-runs",
  "POST /api/invoices/bulk-submit",
]);

export const NO_CONTEXT_ROUTE_PATTERNS: ReadonlyArray<RequestPattern> = [
  { method: "POST", pattern: /^\/api\/clerk\/cases\/[^/]+\/retry$/ },
  { method: "POST", pattern: /^\/api\/invoices\/[^/]+\/invoice-rooms$/ },
  {
    method: "POST",
    pattern: /^\/api\/invoice-rooms\/[^/]+\/(?:replace|revoke)$/,
  },
];

export const MODEL_RATE_LIMITED_ROUTES = new Set([
  "POST /api/clerk/cases",
  "POST /api/clerk/cases/batch",
  "POST /api/clerk/batches",
  "POST /api/clerk/ask",
  "POST /api/clerk/eval/run",
  "POST /api/clerk/eval/canary",
  "POST /api/clerk/eval/model-canary",
  "POST /api/clerk/eval/intent",
  "POST /api/clerk/eval/phrasing",
  "POST /api/clerk/eval/retrieval",
  "POST /api/clerk/format-draft",
  "POST /api/clerk/draft-invoice",
  "POST /api/clerk/narration-suggestions",
  "POST /api/clerk/client-import-draft",
  "POST /api/clerk/catalogue-draft",
  "POST /api/clerk/claims/draft",
  "POST /api/clerk/explain-failure",
  "POST /api/clerk/draft-chaser",
  "POST /api/clerk/reconciliation-assist",
  "POST /api/clerk/advisory-briefs",
  "POST /api/vat-pack/cover-note",
  "POST /api/quarterly-review/cover-note",
  "POST /api/statements",
  "POST /api/clerk/action-proposals/execute",
  "GET /api/compliance-pack",
]);

export const MODEL_RATE_LIMITED_ROUTE_PATTERNS: ReadonlyArray<RequestPattern> =
  [
    { method: "POST", pattern: /^\/api\/clerk\/cases\/[^/]+\/retry$/ },
    { method: "POST", pattern: /^\/api\/engagements\/[^/]+\/narrative$/ },
    { method: "POST", pattern: /^\/api\/escalations\/[^/]+\/reply-draft$/ },
    {
      method: "POST",
      pattern: /^\/api\/obligations\/[^/]+\/response-draft$/,
    },
  ];

function matches(
  method: string,
  path: string,
  routes: ReadonlySet<string>,
  patterns: ReadonlyArray<RequestPattern>,
): boolean {
  return (
    routes.has(`${method} ${path}`) ||
    patterns.some(
      (route) => route.method === method && route.pattern.test(path),
    )
  );
}

export function requestSkipsTenantContext(
  method: string,
  path: string,
): boolean {
  return (
    NO_CONTEXT_PATHS.has(path) ||
    matches(method, path, NO_CONTEXT_ROUTES, NO_CONTEXT_ROUTE_PATTERNS)
  );
}

export function principalBypassesTenantContext(
  principal: Principal | undefined,
): boolean {
  return !principal || BYPASS_ROLES.has(principal.role) || !principal.firmId;
}

export function isModelRateLimitedRoute(method: string, path: string): boolean {
  return matches(
    method,
    path,
    MODEL_RATE_LIMITED_ROUTES,
    MODEL_RATE_LIMITED_ROUTE_PATTERNS,
  );
}
