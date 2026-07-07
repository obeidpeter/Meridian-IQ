---
name: Artifact workflow naming
description: The workflow name for an auto-created web artifact, needed to restart it.
---

`createArtifact({artifactType:"react-vite", slug, title})` auto-creates a workflow
named `artifacts/<slug>: web` — NOT `artifacts/<slug>: <title>`. Restarting with the
title-based name fails with RUN_COMMAND_NOT_FOUND.

**How to apply:** To restart a freshly-created web artifact, use `artifacts/<slug>: web`.
If unsure, call `refresh_all_logs` first — it lists the exact workflow names and their
status (a new artifact starts NOT_STARTED until you restart it).
