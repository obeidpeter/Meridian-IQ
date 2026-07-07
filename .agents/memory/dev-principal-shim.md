---
name: Dev principal shim
description: Rules for the header-based dev auth shim used until Clerk is wired.
---

# The x-mock-* principal shim is dev-only and least-privilege

Until Clerk is wired, `resolvePrincipal` builds the request principal from client headers: `x-mock-user`, `x-mock-role`, `x-mock-firm`, `x-mock-client-party`.

**Rules:**
- Only honor these headers when `NODE_ENV !== "production"`. In production, reject non-public requests with 401 (no verified-session provider is wired yet).
- Never default to a privileged role. Require an explicit valid `x-mock-role`; 401 if missing/invalid.
- Keep truly public routes open without a principal: `/api/healthz` and `/api/verify-stamp`.

**Why:** The shim previously defaulted to `firm_admin` and always trusted headers, so any caller could self-assert admin — a privilege-escalation footgun, especially if it ever ran in production.

**How to apply:** When Clerk is added, populate the principal from the verified session and remove/limit the header path. Keep the public-paths allowlist in sync with any new unauthenticated endpoints.
