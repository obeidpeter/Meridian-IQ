---
name: Cookie-session auth inside the Replit preview iframe
description: Why first-party cookie sessions must use SameSite=None + credentials:include for the web apps, and the CSRF tradeoff that creates.
---

# Cookie-session auth in the cross-site iframe

The web artifacts run inside the Replit preview, which embeds the app in a
**cross-site iframe** (top-level site differs from the app's `*.replit.dev`
origin). This breaks naive cookie-session auth in two ways that both have to be
fixed together:

1. **Cookie `SameSite`** — a `SameSite=Lax`/`Strict` session cookie is NOT sent
   on requests made from within a cross-site iframe, so login succeeds (200,
   `Set-Cookie` sent) but the very next `GET /api/me` is 401. The cookie must be
   `SameSite=None; Secure`. `None` REQUIRES `Secure`, so gate it on https
   (`x-forwarded-proto` behind the proxy) and fall back to `Lax` on plain http
   (localhost) where `None`+`Secure` would be rejected. Clear the cookie on
   logout with the SAME attributes (minus maxAge) or the browser won't match it.
2. **Fetch `credentials`** — the shared client (`lib/api-client-react`
   `custom-fetch.ts`) must send `credentials: "include"` (default it, preserving
   explicit overrides). The Expo/RN client uses a bearer-token getter instead,
   which is unaffected.

**Symptom signature:** `POST /api/auth/login` → 200 immediately followed by
`GET /api/me` → 401 in the api-server logs, with the user appearing stuck on the
sign-in screen.

**Verify:** curl `-D -` the login response and confirm `Set-Cookie … Secure;
SameSite=None`; then a cookie-jar `login → /api/me` round-trip must return 200.
A Playwright e2e (fresh context → sign in → reload still signed in → sign out)
confirms the browser side.

**CSRF tradeoff (important):** `SameSite=None` removes the partial CSRF
protection that `Lax` provided. There is currently NO CSRF token or strict
Origin/Referer enforcement on mutating routes, and `app.use(cors())` defaults
(ACAO `*`, no allow-credentials) are NOT a CSRF defense. If hardening for
production, add a CSRF token (synchronizer/double-submit) or a strict Origin
allowlist on unsafe methods. This was left as a known follow-up, not silently
implemented, because it is a larger security change than the sign-in fix.

**Demo credentials:** the seed (`bootstrap/seed.ts`) defines the demo accounts
and their shared password — read it there; never copy credentials into memory.
