---
name: Principal resolution (Clerk prod + dev shim)
description: How the API resolves the request principal — Clerk in prod, header shim in dev — and why tenancy lives in our DB.
---

# Principal resolution: Clerk identity in prod, header shim in dev

`resolvePrincipal` builds the request `Principal` two ways depending on `NODE_ENV`.

**Production:** identity comes from a Clerk-verified session (`clerkMiddleware()` runs first in `app.ts`, then `getAuth(req).userId`). Tenancy (firm) and role are resolved from OUR `memberships` table keyed by `usersTable.clerkUserId` — NOT from Clerk. A user with multiple memberships disambiguates with the `x-firm-id` header, else the first membership. No verified session or no membership => 401.

**Development:** header shim (`x-mock-user`, `x-mock-role`, `x-mock-firm`, `x-mock-client-party`), only honoured when `NODE_ENV !== "production"`; requires an explicit valid `x-mock-role` (401 if missing/invalid), never defaults to a privileged role.

**Why tenancy is in our DB, not Clerk:** Replit-managed Clerk does NOT support organization tenants (see clerk-auth SKILL "Not supported today"). So the task's "Clerk with organizations" is implemented as Clerk-for-identity + platform-owned `memberships` for firm/role. This is the only viable shape on Replit-managed Clerk.

**Why the dev shim exists:** this task has no frontend to originate Clerk sessions, and the shim previously defaulted to `firm_admin` + always trusted headers (privilege-escalation footgun) — hence least-privilege + prod lockout.

**How to apply:** keep the public-paths allowlist (`/api/healthz`, `/api/verify-stamp`) in sync with any new unauthenticated endpoints. Clerk env vars (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`) are auto-provisioned by `setupClerkWhitelabelAuth`; do not hand-set them.
