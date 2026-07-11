---
name: Expo web preview CORS
description: Why credentialed API calls from the Expo web preview need an explicit CORS origin allowlist
---

The Expo web preview is served from `REPLIT_EXPO_DEV_DOMAIN`, a different origin
than the API server on `REPLIT_DEV_DOMAIN`. The shared fetch client sends
`credentials: "include"`, and browsers reject credentialed cross-origin requests
unless the exact origin is echoed with `Access-Control-Allow-Credentials: true`.

**Why:** Default `cors()` (wildcard origin, no credentials) makes the preflight
OPTIONS *succeed* (204 in server logs) while the browser silently refuses to send
the real request — the symptom is "OPTIONS but never POST" in API logs and a UI
that appears to do nothing on submit.

**How to apply:** Keep the API's CORS as an allowlist of first-party origins
(REPLIT_DEV_DOMAIN, REPLIT_EXPO_DEV_DOMAIN, REPLIT_DOMAINS, localhost in dev)
with `credentials: true`. Never reflect arbitrary origins with credentials —
that would let any site pass the custom-header CSRF guard.
