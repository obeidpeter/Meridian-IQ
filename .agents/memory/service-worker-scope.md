---
name: Root-scoped service worker hijacks sibling artifacts
description: In a path-routed multi-artifact origin, a service worker registered by the "/" app controls ALL sibling apps and can serve them the wrong (cached) content.
---

# Root-scoped service worker hijacks sibling artifacts

In this monorepo every web artifact shares ONE origin, split by path prefix
(`/`, `/console/`, `/penalty-calculator/`, `/__mockup`, `/api`). A service
worker's scope is its registration path. The artifact served at `/` registers
its SW with scope `/`, which controls the **entire origin** — every sibling
artifact, not just itself.

**Symptom:** a sibling artifact (e.g. penalty-calculator) "stops showing" —
renders the root app's shell + a 404, and it **persists through refreshes** for
the affected user but works in a fresh browser / the screenshot tool (which has
no SW). A cache-first SW also permanently pins whatever it first cached for a
sibling path.

**Why:** the root app's SW fetch handler (cache-first, with a fallback to the
root app's shell via `caches.match(self.registration.scope)`) intercepts and
caches sibling paths, serving the root shell for them.

**How to apply / fix:**
- The root app's SW must **bypass every sibling artifact prefix** — `return`
  early (no `respondWith`) for those paths so the browser goes straight to the
  network. Keep the list of foreign prefixes in the SW.
- Bump the SW `CACHE` version so the `activate` handler purges stale entries; the
  SW should `skipWaiting()` + `clients.claim()` so the fix self-heals affected
  users after a refresh (SW scripts are always revalidated, `no-cache`).
- Prefer registering offline SWs in production only, but even then the root SW
  still needs the foreign-prefix bypass because prod shares the origin too.
- Unrelated but co-occurring: also confirm each artifact's `BASE_PATH` matches
  its `previewPath` (see artifact-base-path.md) — both can break the same URL.
