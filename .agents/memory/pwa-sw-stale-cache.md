---
name: PWA service-worker stale cache in dev
description: Why screenshots/preview can show old UI even after HMR + workflow restart in a PWA artifact
---

In a PWA artifact (offline support via a service worker precaching the app shell),
the preview/screenshot can render a STALE bundle even after Vite HMR updates and a
workflow restart. The service worker intercepts requests and serves the cached shell.

**Why:** The SW precache serves old assets until it detects a new SW and activates
(often needing an extra reload or skipWaiting). The screenshot tool loads through the
proxy and gets the SW-cached version.

**How to apply:** Do NOT conclude the code is broken from a stale screenshot alone.
Verify what the dev server actually serves by curling the module directly on the dev
server's real PORT (not :8080, which is the mTLS proxy and returns 401):
`curl -s http://localhost:<PORT>/src/pages/<file>.tsx | grep -c "<new-token>"`.
If the new code is present there and typecheck passes, the change is live; the stale
render is a SW-cache artifact, not a code fault.
