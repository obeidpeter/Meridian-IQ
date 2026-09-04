# Workspace and provider readiness

This document is the operating contract for Meridian Today, universal search,
collaborative work and the production provider relays introduced with API
contract `0.96.0`.

## User-facing workspace

### Meridian Today

`GET /api/workspace/today` builds a role-aware, bounded priority view from the
authoritative records already in the platform:

- Firm staff and business users see open team work, invoices needing action,
  and, when `statutory_desks` is enabled, filings and obligations.
- Buyer users see invoice confirmations addressed to their buyer party.
- Operators retain their activation destination and auditors retain the audit
  destination; neither role receives firm collaboration data.
- Setup steps are derived from persisted evidence. They are not browser-only
  checkboxes and cannot claim completion without the corresponding record.
- Setup steps for reconciliation and ERP feeds appear only when those modules
  are enabled for the firm.

The API limits every source and then returns at most the requested count. The
client refreshes this read model instead of persisting a second copy.

### Universal search

`GET /api/workspace/search?q=...` searches only records the current principal
may open. Firm tenancy, client-party scope and buyer-party scope are applied in
SQL. `%`, `_` and `\` are escaped before `ILIKE`; search text is always a bound
parameter. Compliance records are omitted while `statutory_desks` is dark.

The command menu waits for two characters, debounces calls, aborts stale
requests and keeps local navigation available if remote search fails. Search
telemetry records only closed event/surface labels; it never records the query.

### Collaborative work

`work_items` holds small pointers and coordination state, not copies of invoice
or filing data. `work_item_comments` is an append-only discussion ledger.

Key integrity rules:

- Every read and write is firm-scoped; client users are additionally pinned to
  their own `client_party_id` in route predicates.
- RLS is enabled and forced on both tables as a firm-level backstop.
- `client_request_id` makes task and comment creation idempotent. The web client
  persists a task draft and its retry key on that device until creation is
  confirmed.
- `version` is a compare-and-set guard. A stale update receives `409` and must
  be refreshed rather than overwriting a colleague's change.
- Assignees must be members of the same firm. A client user can own only work
  for their business and can self-assign only.
- Client users can update progress and self-assignment, but cannot rewrite a
  firm's title, context, priority or due date.
- A client user mentioned in a comment must belong to the task's client scope.
- User-supplied links must be relative application paths; absolute, protocol-
  relative, control-character and backslash paths are rejected.

Apply the Drizzle schema before guardrail migration `0047`. Production startup
will re-assert the RLS policy after the table exists, but the release is not
complete until migration status reports all registered guardrails applied.

## Provider readiness

The Connection centre reports presence and mode only. It never returns relay
tokens or stored connection configuration. A connector declares its own fields;
the server rejects undeclared keys, non-string values, control characters and
values longer than 2,048 characters.

Sandbox connectors are deterministic test systems. A card labelled `Sandbox`
is not evidence of production provider connectivity. Live connectors are dark
until both their deployment-owned URL and token are configured. In production,
relay URLs must use HTTPS and must not contain user information.

### Required deployment secrets

| Capability | URL | Server credential |
| --- | --- | --- |
| ERP/accounting | `ERP_CONNECTOR_URL` | `ERP_CONNECTOR_TOKEN` |
| Open banking | `BANK_FEED_URL` | `BANK_FEED_TOKEN` |
| Messaging and access requests | `MESSAGING_WEBHOOK_URL` | `MESSAGING_WEBHOOK_TOKEN` |
| Hosted payments | `PAYMENT_PROVIDER_URL` | `PAYMENT_PROVIDER_TOKEN` |
| Tax access point | `RAIL_PRIMARY_URL` / `RAIL_SECONDARY_URL` | The corresponding rail token or signed key ring |

Provider credentials belong in Replit Secrets or the deployment secret store,
never source, browser environment variables, connection forms or database
rows. Live ERP and bank connection rows store only a non-secret `accountRef`;
vendor OAuth and token rotation remain behind the relay.

### ERP relay protocol

MeridianIQ sends `POST` with JSON and `x-op-token` to `ERP_CONNECTOR_URL`.

Authentication request:

```json
{
  "kind": "erp_authenticate",
  "config": { "accountRef": "provider-account-reference" }
}
```

Response:

```json
{ "ok": true }
```

Invoice pull request:

```json
{
  "kind": "erp_pull_invoices",
  "config": { "accountRef": "provider-account-reference" },
  "cursor": null,
  "limit": 100
}
```

Response rows use canonical string fields:

```json
{
  "rows": [
    {
      "invoiceNumber": "INV-1001",
      "buyerName": "Example Buyer Ltd",
      "buyerTin": "12345678-0001",
      "issueDate": "2026-09-04",
      "description": "Professional services",
      "quantity": "1",
      "unitPrice": "250000.00",
      "vatRate": "0.075"
    }
  ],
  "nextCursor": "opaque-provider-cursor",
  "hasMore": false
}
```

### Bank relay protocol

MeridianIQ uses the same transport headers at `BANK_FEED_URL`.

Authentication uses `kind: "bank_authenticate"` with the connection `config`.
A pull uses `kind: "bank_pull_lines"`, `config`, `cursor` and `limit` and returns:

```json
{
  "lines": [
    {
      "valueDate": "2026-09-04",
      "amount": "250000.00",
      "direction": "credit",
      "narration": "NIP transfer",
      "reference": "BANK-REF-1001"
    }
  ],
  "nextCursor": "opaque-provider-cursor"
}
```

Pulled lines always enter through the ordinary statement-ingest and consent
path. A connector must never insert directly into `bank_statement_lines`.

Both live relays have an eight-second timeout, reject redirects, bound response
size, and validate response shape. Connectivity tests run outside the request's
tenant transaction so a slow provider does not hold a database connection.
Workers authenticate again before each pull.

## Rollout checklist

1. Build contract `0.96.0` and all web artifacts from the same revision.
2. Apply the database schema, then run guardrail migrations through `0047`.
3. Confirm `/api/readyz` and the operator release-readiness panel are healthy.
4. Add provider URL/token pairs in Replit Secrets. Never paste the server token
   into a client connection form.
5. Enable `erp_connectors`, `bank_feeds`, `reconciliation` and
   `statutory_desks` only for their intended cohorts.
6. In Connection centre, select a live adapter, enter the non-secret account
   reference, run **Test connection**, then save and run one sync.
7. Verify the imported record passed the normal validation/consent path and
   inspect the audit and sync-run evidence.
8. Exercise Today, search and one collaborative task as firm staff and as the
   matching client user. Confirm a sibling client is not searchable or readable.
9. Run a poor-network retry and verify only one task/comment was created.
10. Record moderated keyboard, screen-reader and mobile evidence before setting
    `USABILITY_VALIDATED_AT`.

## Identity boundary

This release does not add SAML or OIDC federation. Architecture decision D14
still applies: local/Clerk identity, TOTP, access-register attestation and global
session revocation are the supported launch controls. Enterprise SSO requires a
separate identity-provider design, migration plan and threat model; it must not
be implied by the UI or marked ready through configuration alone.
