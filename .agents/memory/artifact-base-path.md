---
name: Web artifact BASE_PATH must match previewPath
description: Blank/404/wrong-app render in path-routed web artifacts is usually a stale BASE_PATH in the running dev server, not a code bug.
---

# Web artifact BASE_PATH / previewPath mismatch

Each path-routed web artifact's vite dev server reads `base` from the `BASE_PATH`
env var (injected from `.replit-artifact/artifact.toml` `[services.env]`). It must
equal the artifact's `previewPath` (e.g. `/penalty-calculator/`).

**Symptom seen:** a non-root artifact rendered the *root* artifact's shell with a
wouter "404 Page Not Found". Root cause: the running vite process had a stale
`BASE_PATH=/` (not `/penalty-calculator/`), so its `index.html` referenced
`/src/main.tsx` (unprefixed). The proxy routed that unprefixed asset request to the
root app (previewPath `/`), which then booted and 404'd on the unknown path.

**Why:** the toml can be correct while the *running process* holds an old env from
before the toml was fixed (e.g. after an artifact was added/merge reconciliation ran).

**How to apply / diagnose:**
- `curl <proxy>/<slug>/` and check the `main.tsx` script src — it must be
  `/<slug>/src/main.tsx`, not `/src/main.tsx`.
- Confirm the live process env: `tr '\0' '\n' < /proc/<vitepid>/environ | grep BASE_PATH`.
- Fix by **restarting that artifact's workflow** so it re-reads `[services.env]`.
  Do NOT edit `.replit`/`artifact.toml` by hand — use the artifacts skill if the
  toml itself is wrong.
