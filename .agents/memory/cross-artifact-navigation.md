---
name: Cross-artifact navigation in the path-routed monorepo
description: How to link between the separate web artifacts (landing, console, buyer-portal, etc.) that share one origin under different base paths.
---

# Cross-artifact navigation

The web artifacts share ONE origin and are path-routed: landing at `/`,
sme-compliance at `/app/`, console at `/console/`, buyer-portal at `/buyer/`,
penalty-calculator at `/penalty-calculator/`.

**Rule:** To navigate *between* artifacts — e.g. an "All apps" / back-to-landing
link, or the landing page linking out to an app — use a full-page anchor
`<a href="/target/">`, never a wouter `<Link>`.

**Why:** Each app's wouter router is configured with a base path, so
`<Link href="/">` resolves to that app's own root (e.g. `/console/`), not the
origin root. Only a raw `<a>` escapes the base path and performs a real
cross-app navigation. The landing page links out the same way
(`<a href={app.href}>` with trailing-slash paths like `/console/`).

**How to apply:**
- Intra-app navigation → wouter `<Link>`.
- Inter-app navigation, including returning to the landing page at `/` → plain
  `<a href="/...">`.
- The shared "return to landing" affordance is an "All apps" link with the
  lucide `Grid2x2` icon: in the sidebar footer for apps that have a sidebar
  (sme-compliance, console, buyer-portal), or in the header for apps without one
  (penalty-calculator).
