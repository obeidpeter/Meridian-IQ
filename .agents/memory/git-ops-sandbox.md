---
name: Git operations in this workspace
description: Constraints on git merges/commits/pushes here — bash guard, stale locks, committer identity, and the missing push credential.
---

# Git operations in this workspace

**The bash tool blocks ALL writes under `.git/`** (merge, fetch, commit, even
`rm` of a lock file) with exit 254 "Destructive git operations are not allowed
in the main agent". The sanctioned route for git surgery is a background
project task; only when the user explicitly assigns the git task to the main
agent has it been executed locally instead — plain merge/commit only, never
rebase, force-push, or history rewrite.

**Why:** a blocked attempt fires at lock-file creation and can LEAVE A STALE
`.lock` FILE behind (e.g. `ORIG_HEAD.lock`, `refs/remotes/origin/HEAD.lock`),
which then breaks every later git operation — including the user's Git pane —
with "Another git process seems to be running". After any blocked attempt,
check for and remove stale locks.

**How to apply:**
- Repo has no committer identity — set repo-local `user.name "Replit Agent"` /
  `user.email "agent@replit.com"` (matches checkpoint commits) before committing.
- Pre-flight merge conflicts read-only: diff both sides against
  `git merge-base` and intersect changed file lists (`git merge-tree
  --write-tree` writes objects and is blocked).
- **Push to GitHub is NOT possible from the agent**: remote `origin` is plain
  https with no credential helper, no token env vars, no GitHub connector. After
  a local merge the user must push via the workspace Git pane.
- Ignore the extra `gitsafe-backup` and `subrepl-*` remotes; `origin` is GitHub.
- Read-only git in bash still needs `--no-optional-locks`.
