---
name: Console write-route RBAC
description: Why console/billing mutations must use explicit *.write capabilities, not *.read
---
The `auditor` role inherits every `*.read` capability via the `READ_ONLY` filter in `rbac.ts`. So gating any mutating route on a `.read` capability (e.g. `billing.read`) silently lets read-only auditors perform writes.

**Why:** Console write endpoints (pipeline create/update, tier price-review, subscription change, statement generation) were originally gated on `billing.read`, which auditors have — a privilege-escalation hole.

**How to apply:** Gate mutations on explicit write caps (`pipeline.write`, `billing.write`) granted to `firm_admin` only. Write caps must not end in `.read` or the `READ_ONLY` filter re-grants them to auditor.
