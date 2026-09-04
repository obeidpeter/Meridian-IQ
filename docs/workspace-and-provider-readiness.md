# Workspace and provider readiness

This document is the operating contract for Meridian Today, universal search,
collaborative work, Invoice Room, the R3 credit evidence perimeter, and the
production provider relays available with API contract `0.98.0`.

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

Apply the Drizzle schema before guardrail migrations `0047` and `0048`.
Production startup will re-assert the RLS policies after the tables exist, but
the release is not complete until migration status reports every registered
guardrail applied.

### Invoice Room

Invoice Room gives the recipient of a stamped invoice a secure, account-optional
workspace at `/invoice-room`. Suppliers create, replace, revoke, and monitor
links from the invoice or **Invoice Rooms** control centre. Buyers can inspect
the canonical lines and stamp, download the PDF, verify their saved email or
WhatsApp destination, respond, create a hosted payment link, report payment,
and attach the invoice to Buyer Rails.

The URL credential is generated from cryptographic randomness, stored only as
a SHA-256 digest for lookup, and placed after `#` so it is not sent in HTTP
requests, proxy logs, or referrers. The landing app exchanges it immediately
for a 30-minute, path-scoped HttpOnly cookie and removes the fragment. OTPs
expire after 10 minutes, are bound to that room session, and gate every action
that changes invoice state. Replacing or revoking a link invalidates its active
sessions. Public responses are `no-store` and `noindex`; room events are
append-only and payment/response writes are idempotent.

Migration `0048` enables and forces tenant RLS on supplier-owned room tables,
keeps public sessions bypass-only, and installs the append-only event trigger.
The `invoice_room` flag ships dark in production and requires
`invoice_lifecycle` plus `buyer_confirmations`. Do not enable it until the
security settings below are reported configured in **Platform operations >
Rail configuration**.

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

| Capability                    | URL                                       | Server credential                                                 |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
| ERP/accounting                | `ERP_CONNECTOR_URL`                       | `ERP_CONNECTOR_TOKEN`                                             |
| Open banking                  | `BANK_FEED_URL`                           | `BANK_FEED_TOKEN`                                                 |
| Messaging and access requests | `MESSAGING_WEBHOOK_URL`                   | `MESSAGING_WEBHOOK_TOKEN`                                         |
| Hosted payments               | `PAYMENT_PROVIDER_URL`                    | `PAYMENT_PROVIDER_TOKEN`                                          |
| Collection accounts           | `COLLECTION_PROVIDER_URL`                 | `COLLECTION_PROVIDER_TOKEN`                                       |
| Collection payment callback   | `/api/collections/inbound`                | `COLLECTION_WEBHOOK_KEYS`                                         |
| Invoice Room public links     | `PUBLIC_APP_URL`                          | `INVOICE_ROOM_ENCRYPTION_KEY`                                     |
| Invoice Room buyer checkout   | `INVOICE_PAYMENT_PROVIDER_URL`            | `INVOICE_PAYMENT_PROVIDER_TOKEN`                                  |
| Invoice Room payment callback | `/api/invoice-room/payments/confirm`      | `INVOICE_PAYMENT_WEBHOOK_KEYS` or `INVOICE_PAYMENT_WEBHOOK_TOKEN` |
| Tax access point              | `RAIL_PRIMARY_URL` / `RAIL_SECONDARY_URL` | The corresponding rail token or signed key ring                   |

Provider credentials belong in Replit Secrets or the deployment secret store,
never source, browser environment variables, connection forms or database
rows. Live ERP and bank connection rows store only a non-secret `accountRef`;
vendor OAuth and token rotation remain behind the relay.

`INVOICE_ROOM_ENCRYPTION_KEY` must decode to exactly 32 bytes (64 hexadecimal
characters or standard base64). `PUBLIC_APP_URL` must be the externally
reachable HTTPS origin; production fails closed instead of issuing links to a
fallback host. The payment callback uses the standard signed machine-request
contract. A deployment may omit the Invoice Room payment provider and still
offer verified responses, payment reporting, PDF download, and the supplier's
bank-transfer instructions.

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

### Collection-account settlement feed

The bank or PSP posts observed payments to `POST /api/collections/inbound`.
The route is absent (`404`) while both `COLLECTION_WEBHOOK_KEYS` and the legacy
`COLLECTION_WEBHOOK_TOKEN` are empty. Production must use the key ring and keep
`OP_LEGACY_TOKENS=off`.

Required headers are `x-op-key-id`, `x-op-timestamp` (Unix seconds) and
`x-op-signature`. The signature is `v1=` plus the hex HMAC-SHA256 of
`timestamp.METHOD.path.sha256(rawBody)`. It is bound to the exact bytes and
accepted only inside `OP_SIGNATURE_WINDOW_SECONDS` (default 300). The body is:

```json
{
  "accountReference": "provider-account-reference",
  "amount": "250000.00",
  "invoiceNumber": "INV-1001",
  "reference": "provider-unique-payment-reference",
  "paidAt": "2026-09-04T10:30:00.000Z"
}
```

The provider must deliver at least once and reuse `reference` on a retry.
MeridianIQ durably records before returning `202 {"received":true}`; a replay
does not create a second settlement. Unknown, inactive and mismatched account
references receive the same acknowledgement and no invoice detail. Raw payloads
and credentials are not logged. The executable profile and version are visible
to operators under **Control centre > Credit**.

### Credit and bank Data Room readiness

The `credit_readiness` pilot evaluates only invoices with explicit Layer-3
consent. Auto-eligibility requires a live canonical stamp, buyer confirmation
and no-set-off, settlement from statement match, paid buyer flag or collection
account, and a current verified KYB outcome. Uploaded evidence never satisfies
the settlement source. Every decision stores the exact scorecard, ruleset,
source facts, policy and hash for deterministic replay.

`bank_data_room` is a dependent R3 flag and must stay globally dark until the
Credit governance check passes. A bank identity has no invoice, party or audit
capabilities. Each request independently verifies TOTP plus the latest DPA-bound
access event, then returns only fixed quarterly/amount-band cohorts with at
least five distinct currently consenting businesses. There are no arbitrary
filters, raw exports, exact amounts or business identifiers. Every served or
suppressed view is appended to the bank access ledger.

Deployment evidence variables:

| Variable                               | Meaning                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `CREDIT_PILOT_MIN_BUSINESSES`          | Minimum observable pilot businesses; default `300`.                 |
| `CREDIT_COHORT_MIN_SIZE`               | Privacy threshold; may raise but never lower the hard floor of `5`. |
| `CREDIT_DPIA_APPROVED_AT`              | ISO timestamp of the retained, approved R3 DPIA.                    |
| `CREDIT_BANK_MOU_REFERENCE`            | Opaque reference to the retained conditional bank MOU.              |
| `CREDIT_COLLECTION_FEED_AGREED_AT`     | ISO timestamp when the signed settlement profile was agreed.        |
| `CREDIT_COLLECTION_FEED_AGREEMENT_REF` | Opaque reference to the retained feed agreement.                    |
| `TOTP_REQUIRED_ROLES`                  | Must include `bank_user` before a bank pilot is activated.          |

None of these variables enables lending. R4 applications, offers, pricing,
funding, repayment and marketplace behavior have no route or user interface.

## Rollout checklist

1. Build contract `0.98.0` and all web artifacts from the same revision.
2. Apply the database schema, then run guardrail migrations through `0049`.
3. Confirm `/api/readyz` and the operator release-readiness panel are healthy.
4. Add provider URL/token pairs in Replit Secrets. Never paste the server token
   into a client connection form.
5. Enable `erp_connectors`, `bank_feeds`, `reconciliation`, `statutory_desks`,
   and `invoice_room` only for their intended cohorts and after each one's
   prerequisites are ready.
6. In Connection centre, select a live adapter, enter the non-secret account
   reference, run **Test connection**, then save and run one sync.
7. Verify the imported record passed the normal validation/consent path and
   inspect the audit and sync-run evidence.
8. Exercise Today, search and one collaborative task as firm staff and as the
   matching client user. Confirm a sibling client is not searchable or readable.
9. Run a poor-network retry and verify only one task/comment was created.
10. Record moderated keyboard, screen-reader and mobile evidence before setting
    `USABILITY_VALIDATED_AT`.
11. For Invoice Room, create a short-lived test link, open it in a private
    browser, verify the intended channel, submit one response, retry that same
    request, and confirm only one event exists. Revoke the link and verify both
    the original URL and its prior room session return `410`.
12. For an R3 credit pilot, complete the activation sequence in
    [Release readiness](release-readiness.md), verify a sub-five cohort is
    suppressed, verify a five-business cohort contains no identifiers or exact
    amounts, revoke the bank grant, and confirm the next request is `403`.

## Identity boundary

This release does not add SAML or OIDC federation. Architecture decision D14
still applies: local/Clerk identity, TOTP, access-register attestation and global
session revocation are the supported launch controls. Enterprise SSO requires a
separate identity-provider design, migration plan and threat model; it must not
be implied by the UI or marked ready through configuration alone.
