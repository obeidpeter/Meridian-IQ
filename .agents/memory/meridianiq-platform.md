---
name: MeridianIQ platform invariants
description: Non-obvious access-control and UBL invariants for the api-server data spine
---
# MeridianIQ api-server invariants

- **Parties are shared reference data (no firmId).** The tenant boundary for a party is the engagements table linking a firm to a client party. Any route exposing a party or its consent by arbitrary partyId must enforce an engagement-based access check (`assertPartyAccess`) or it becomes a cross-tenant IDOR. Operator/auditor (no tenant firm) are unrestricted.
  **Why:** without this, any firm-scoped principal can read/write another firm's client party and consent records.
  **How to apply:** call the party-access guard in every handler that takes a `:partyId`/`:id` party path param before touching party or consent data.

- **Dark feature = unreachable.** A release-tagged feature seeded OFF must be gated by the feature-flag service returning 404 when off, and the gate runs BEFORE the RBAC check so the surface is invisible regardless of role. Merely having a flag service is not enough — the routes themselves must be gated.
  **Why:** reviewers require positive proof that dark features cannot be reached, not just that a flag exists.

- **Feature flags seed with onConflictDoNothing** — changing a flag's default value in the seed does NOT update an already-seeded row. To restore a flag's intended (e.g. dark) state you must UPDATE the DB row directly.

- **UBL unit of measure is an attribute, not an element.** The invoiced-quantity element carries `unitCode` as an XML attribute (UBL 2.1). The builder must emit it as `{ "#text": qty, "@_unitCode": code }` and the parser must be attribute-aware (`ignoreAttributes:false`, `attributeNamePrefix:"@_"`) reading text and attribute separately.

- **RBAC READ_ONLY** = capabilities ending in `.read` plus `audit.export`; the auditor role inherits it, so any newly added `.read` capability is automatically granted to auditor.
