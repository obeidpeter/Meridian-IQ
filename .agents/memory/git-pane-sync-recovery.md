---
name: Git pane sync recovery
description: GitHub Git-pane syncs bypass post-merge.sh — new deps stay uninstalled and Vite/Metro throw "Failed to resolve import"; run pnpm install + restart affected workflows after every sync.
---

# Git pane sync recovery

Syncs pulled through the Git pane from GitHub do NOT trigger
`scripts/post-merge.sh` (that script only runs after platform task-agent
merges). So any new workspace packages or npm deps added on the remote arrive
uninstalled.

**Why:** this has broken apps repeatedly — symptoms are always the same: page
curls 200 but Vite serves "Internal server error: Failed to resolve import
\"@workspace/…\"" (web apps) or Metro "Unable to resolve \"<pkg>\"" (Expo).
The workflow status stays RUNNING, so it looks healthy until logs are read.

**How to apply:** after every Git-pane sync, run the same steps post-merge.sh
would have run:
1. `pnpm install` (links new workspace packages + installs npm deps)
2. `pnpm --filter db push-force && pnpm --filter db migrate` if schema changed
3. Restart every workflow whose artifact gained deps (Vite needs a restart to
   re-optimize; api-server builds once at startup). Expo web only re-bundles on
   the next request — trigger a curl of `https://$REPLIT_EXPO_DEV_DOMAIN/` and
   look for "Web Bundled" (success) vs "Web Bundling failed" in fresh logs.
