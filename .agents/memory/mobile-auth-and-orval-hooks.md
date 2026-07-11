---
name: Mobile bearer auth + orval hook overrides
description: Gotchas for the Expo mobile client — login-token gating and react-query option overrides in generated hooks.
---

## Login token is gated by client header
The API's `/auth/login` returns the bearer token in the JSON body **only** when the request carries `X-Meridian-Client: mobile`. Browser web apps stay HttpOnly-cookie-only.
**Why:** exposing a replayable bearer token to browser JS widens XSS blast radius (architect review finding).
**How to apply:** any new native client must send that header on login (via the generated hook's `request: { headers }` option); never add the token back unconditionally.

## Orval react-query v5 hooks require queryKey in overrides
Passing `{ query: { enabled: ... } }` to a generated hook fails typecheck — v5's `UseQueryOptions` requires `queryKey`. Always pass the matching `getXQueryKey(...)` alongside `enabled`.

## Serialized preference writes on mobile
Full-replacement PUTs built from a query snapshot lose updates under rapid toggling. The settings screen keeps a local draft ref and serializes writes through a promise queue; each write is built from the latest draft.
**How to apply:** reuse this pattern for any full-object PUT driven by individual toggles.
