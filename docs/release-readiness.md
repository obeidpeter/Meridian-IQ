# Release readiness

The operator's **Platform operations > Release readiness** panel evaluates the
running deployment. A production release is not complete while any check is
`Blocked`; warnings are explicit accepted risks rather than hidden assumptions.

## Automated evidence

- **Deployment revision:** set `EXPECTED_BUILD_REVISION` to the Git SHA being
  deployed. Replit should expose the running revision through `REPLIT_GIT_SHA`.
- **Database migrations:** schema push and every numbered guardrail migration
  must match the repository registry. Migration `0047` protects Team work;
  migration `0048` must report Invoice Room RLS plus its append-only event
  trigger before `invoice_room` is enabled.
- **Scheduled work:** run `pnpm --filter @workspace/scripts run ops:sweep` about
  every five minutes from a Replit Scheduled Deployment. It signs the request
  using `SWEEP_KEY_ID` + `SWEEP_KEY_SECRET`, the first `SWEEP_KEYS` entry, or a
  single `SWEEP_TOKEN` as key id `legacy`.
- **Backup:** run `ops:backup` outside the API deployment at least daily and
  copy the dump plus checksum off-box.
- **Restore drill:** run `ops:restore-drill` against a disposable target at
  least every 31 days and before a material production migration.
- **Security:** configure signed machine-key rings, keep
  `OP_LEGACY_TOKENS=off`, protect metrics, and require TOTP for `operator` and
  `firm_admin`.
- **Pipeline and flags:** clear aged outbox work and dependency violations
  before promotion.
- **Provider readiness:** open **Integrations > Readiness** and confirm every
  provider required by the release is `ready`. Exercise the ERP and bank
  connection tests with non-production test accounts before saving a live
  connection. The environment variables, request contracts, and rollback
  sequence are in [Workspace and provider readiness](workspace-and-provider-readiness.md).
- **Invoice Room:** the release-readiness panel must show **Invoice Room
  security** as passing before its flag is enabled. Confirm `PUBLIC_APP_URL`
  and a valid 32-byte `INVOICE_ROOM_ENCRYPTION_KEY`; configure the messaging
  relay for delivery/OTP and the invoice payment provider only for the channels
  included in the release.
- **Collaboration retry drill:** create a task, interrupt the response, and
  retry from the same browser. Confirm that one task exists, then repeat for a
  comment and verify that its original text cannot be edited or deleted.

## Human and third-party evidence

These checks cannot be truthfully completed by source code alone:

1. Verify that mail sent to `advisory@meridianiq.com` is received, triaged, and
   answered. Set `ADVISORY_INBOX_VERIFIED_AT` to that test's ISO timestamp.
   Repeat within 90 days and after any mail-provider change.
2. Run moderated tasks with representative SME owners, firm staff, firm admins,
   buyers, operators, and an auditor on mobile and desktop. Include keyboard and
   screen-reader use, poor-network retries, long names, and recovery from an
   interrupted write. Record findings and fixes, then set
   `USABILITY_VALIDATED_AT`; put the report or ticket reference in
   `USABILITY_EVIDENCE_REF`. Repeat within 180 days after major workflow work.
   Include a no-account Invoice Room journey, OTP recovery, a revoked link,
   duplicate submission, 200% zoom, and a 320 CSS-pixel viewport.
3. Obtain and retain production authority-rail accreditation evidence before
   setting `RAIL_ACCREDITATION_CONFIRMED=true`. Set `REQUIRE_LIVE_RAILS=true`
   only for a release that must use accredited live rails; it turns any
   simulator, sandbox, or partial configuration into a blocking check.

Dates are evidence attestations, not bypasses. The supporting report, mail test,
or accreditation record must exist outside the environment variable.
