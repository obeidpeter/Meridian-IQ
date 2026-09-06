---
name: Production bootstrap claims
description: Why one-time privileged bootstrap consumption must survive ordinary application and migration rollbacks.
---

**Rule:** A consumed production privileged-bootstrap claim is irreversible during normal application rollback. Rollback code must preserve both the claim row and its database protections.

**Why:** If rollback removes the consumption record while deployment bootstrap credentials remain configured or are restored, a later restart can create another privileged identity. Account deletion must not reactivate the bootstrap either.

**How to apply:** Treat bootstrap-consumption records like retained security evidence, not reversible feature data. New rollback tooling and migrations must keep the singleton claim, bypass-only access policy, and immutability enforcement intact unless a separately governed full data reset is explicitly authorized.