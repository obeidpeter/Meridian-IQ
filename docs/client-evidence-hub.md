# Client Evidence Hub

The Evidence Hub adds a private document-request workflow to the accounting
console and business workspace. It is an additive feature, not a tax-authority
submission, payment-verification service or anonymous file-sharing portal.

## Workflow

An accounting-team member requests a document for one client invoice, filing or
reporting month. The request has a document type, owner and optional deadline.
Clients see only their own business's requests. Staff can update an open
request's owner or deadline. The same request appears in Today and Team work;
its status is maintained by the evidence workflow, not an independent task edit.

Uploads are immutable versions. The request moves from Requested to Uploaded,
while the file remains quarantined until its security scan finishes. Staff may
accept only the latest clean version, ask for changes with a comment, or cancel
with a comment. Asking for changes reopens an accepted request without deleting
its prior versions or review events. Cancelled requests cannot be reopened.

Document acceptance does not submit an invoice, file a return, confirm payment
or prove that a tax authority accepted a record. Clerk's document checks provide
source-grounded comparisons and explicit unknown results. Scanned images require
visual review; this feature does not send them to an AI provider or auto-approve.

Accepted requests can be downloaded as a ZIP evidence pack containing the
original accepted document, review-history manifest, and invoice PDF and stamp
metadata when applicable. The pack distinguishes sandbox evidence from live
provider evidence. Files in quarantine never enter a pack.

## Security and Concurrency

- Human account, capability, firm membership, client scope and non-archived
  engagement are checked server-side. Operators, auditors, buyers and machine
  API keys do not receive access to private evidence documents.
- PostgreSQL enforces firm RLS, cross-reference integrity, immutable file
  content, append-only review events and clean-version acceptance constraints.
- Create, upload, assignment and review commands use idempotency keys. Changed
  payloads cannot reuse a key. Version checks reject stale updates. A firm-level
  transaction lock serializes quota checks and writes across instances.
- Content is encrypted with AES-256-GCM, with firm/request/file IDs bound as
  authenticated data. Downloads verify size and SHA-256, use attachment headers,
  disable caching and require a clean scan. Filenames are never filesystem paths.
- Inputs are limited to PDF, PNG and JPEG, at most 5 MiB per file, 20 versions
  per request, 100 MiB per firm and 5,000 requests per firm. These initial limits
  bound the database-backed storage release; expansion needs capacity planning.
- PDF intake uses bounded structural inspection in an isolated child process:
  at most 100 pages, 5,000 inspected structures, 10 seconds and a 128 MiB JavaScript
  heap, with two concurrent inspections per API process. Encrypted, unreadable
  or active documents are refused. This inspection does not replace the malware
  scan or claim to sanitize a document. Document-check text extraction has a
  separate 20-page limit and reports unavailable extraction for larger documents.
- Filenames, document content and extracted text are not sent to notifications,
  analytics or application logs. Browser drafts stay in memory, not local storage.

## Activation

The API contract is `0.104.0`. Migration `0057` creates the tables, enums,
indexes and guardrails additively through the supported migration-only release
flow, using newly built matching artifacts. Do not run inferred Drizzle schema
pushes against a serving deployment.
Never mix these sources with previously staged `dist` trees or manifests.

`evidence_hub` defaults off in production and on in seeded development. Before
activating a production pilot:

1. Set `EVIDENCE_ENCRYPTION_KEY` to a dedicated random 32-byte secret, encoded as
   64 hexadecimal characters or canonical base64. Keep it in deployment secrets,
   never source control. An absent or invalid production key blocks uploads.
2. Run a maintained ClamAV daemon on a protected loopback endpoint and set
   `EVIDENCE_CLAMAV_PORT` to its port. Valo uses the documented
   [ClamAV INSTREAM protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html).
   No user-supplied host or URL is accepted. A remote managed scanner requires an
   operator-controlled encrypted tunnel terminating on loopback, not an exposed
   plaintext clamd port. Set `StreamMaxLength` to at least 5 MiB, enable PDF/image
   scanning and keep signatures current.
3. Verify clean, rejected, malformed, unavailable and timeout scanner outcomes
   with approved synthetic fixtures. Missing scanning configuration is never a
   successful scan: stored documents remain quarantined and cannot be accepted.
4. Confirm the normal pipeline sweep is running. Scan claims use expiring leases,
   bounded batches and an eight-second socket deadline. Five failed attempts stop
   automatic retries; an authorized reviewer can request another attempt.
   Graceful interruption records a retryable outcome. An expired claim exhausted
   by abrupt shutdowns also remains retryable without marking the file clean.
5. Test client/staff access, revoked membership, concurrent review, downloads,
   evidence packs and in-app reminders in a pilot firm before wider activation.

No scanner service, production secret, feature flag or live deployment is enabled
by this source change alone. No paid integration is provisioned.

## Recovery and Retention

Existing database backups include encrypted evidence rows. A disaster-recovery
backup also needs the dedicated encryption key, held separately with restricted
access. Verify a restore and sample-file digest in a disposable database before
relying on the backup. Changing or losing the key without a re-encryption plan
makes existing content unreadable. Local development keys are not suitable for
production recovery.

This first release retains versions and review history; there is no self-service
hard deletion or automatic retention purge. Agree a retention and lawful-deletion
process before storing regulated production records. Capacity beyond the initial
limits should move content to private versioned object storage while preserving
request permissions, immutable metadata, scanning and backup verification.

## Local Verification

The implementation was checked against a disposable loopback PostgreSQL database
upgraded from the previous committed schema using migrations only. Coverage
includes tenant isolation, restricted runtime grants, immutable file versions,
cross-client denial, command replay, competing writes, interrupted scanner
recovery, private notifications, linked work and HTTP validation/CSRF boundaries.

Repository quality checks, unit/pure tests and the API plus five web builds passed.
Two existing hook-dependency lint warnings remain in `use-invoice-drafts.ts`.
The shared UI was checked in both apps at 320, 768 and 1440 pixels, including
keyboard access, automated accessibility checks, overflow and failed-request
recovery. Actual synthetic staff/client sign-in was also checked against the local
API; staff default-client metadata does not pin the accounting team's client list.

No production database, credentials, provider, feature flag or deployment was
changed during verification. A real scanner and a reviewed production activation
remain separate release tasks.
