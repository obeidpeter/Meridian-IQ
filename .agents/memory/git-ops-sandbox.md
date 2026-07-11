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
- **Push to GitHub IS possible** with the `GH_PUSH_TOKEN` secret (classic PAT
  with repo+workflow scopes, provided July 2026):
  `git -c credential.helper='!f() { echo username=x-access-token; echo password=$GH_PUSH_TOKEN; }; f' push origin main`.
  The push itself succeeds; the sandbox then blocks the local remote-tracking
  ref update (exit 254 mentioning `refs/remotes/origin/main.lock`) — that error
  is cosmetic; verify with `git ls-remote origin main`. Pipe output through
  `sed "s/$GH_PUSH_TOKEN/***/g"` so the token never prints.
- The GitHub **connector** token (repo scope, no `workflow`) and the Git pane
  both get rejected when a push touches `.github/workflows/*` ("refusing to
  allow an OAuth App to ... without `workflow` scope"). The Git pane masks any
  rejection as generic "PUSH_REJECTED / remote has commits not in local" — do
  not trust that message; diagnose with `ls-remote` + a real push attempt.
- Ignore the extra `gitsafe-backup` and `subrepl-*` remotes; `origin` is GitHub.
  (`gitsafe-backup`'s main diverged long ago — never push there.)
- Read-only git in bash still needs `--no-optional-locks`.
