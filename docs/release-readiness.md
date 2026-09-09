# Release readiness

The operator's **Platform operations > Release readiness** panel evaluates the
running deployment. A production release is not complete while any check is
`Blocked`; warnings are explicit accepted risks rather than hidden assumptions.

## Automated evidence

- **Deployment revision:** set `EXPECTED_BUILD_REVISION` to the Git SHA being
  deployed. Replit should expose the running revision through `REPLIT_GIT_SHA`.
- **Database migrations:** reviewed additive schema SQL and every numbered guardrail migration
  must match the repository registry. Migration `0047` protects Team work;
  migration `0048` must report Invoice Room RLS plus its append-only event
  trigger before `invoice_room` is enabled.
- **Scheduled work:** run `pnpm --filter @workspace/scripts run ops:sweep` about
  every five minutes from a Replit Scheduled Deployment with `SWEEP_URL` set to
  the deployment's `https://<host>/api/internal/sweep` (there is no default
  host). It signs the request using `SWEEP_KEY_ID` + `SWEEP_KEY_SECRET`, the
  first `SWEEP_KEYS` entry, or a single `SWEEP_TOKEN` as key id `legacy`.
- **Backup:** run `ops:backup` outside the API deployment at least daily and
  copy the dump plus checksum off-box.
- **Restore drill:** run `ops:restore-drill` against a disposable target at
  least every 30 days and before a material production migration.
- **Security:** configure signed machine-key rings, keep
  `OP_LEGACY_TOKENS=off`, protect metrics, and require TOTP for `operator`,
  `firm_admin`, and every provisioned `bank_user`.
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
- **R3 credit perimeter:** keep `credit_readiness` and `bank_data_room` dark
  until **Control centre > Credit** has no blocker. The check requires at least
  `CREDIT_PILOT_MIN_BUSINESSES` credit-observable businesses (default 300), a
  dated DPIA, a conditional bank MOU reference, an agreed signed collection
  feed, one active MFA/DPA-governed bank user, and a passing replay over at
  least 30 assessments. A structural replay is not predictive-loss evidence.

## R3 credit activation sequence

1. Apply the additive schema and guardrail migration `0049`. Confirm the
   legacy `eligibility_assessments` table is bypass-only and the new credit
   evidence ledgers are append-only.
2. Set `TOTP_REQUIRED_ROLES=operator,firm_admin,bank_user`, enroll the bank
   reviewer, then record its DPA-bound access grant from **Control centre >
   Credit**.
3. Configure the collection provider's signed `COLLECTION_WEBHOOK_KEYS` ring,
   leave `OP_LEGACY_TOKENS=off`, and complete a replay-safe 202 callback test.
4. Retain the approved DPIA, conditional bank MOU and feed agreement outside
   source control. Set `CREDIT_DPIA_APPROVED_AT`, `CREDIT_BANK_MOU_REFERENCE`,
   `CREDIT_COLLECTION_FEED_AGREED_AT`, and
   `CREDIT_COLLECTION_FEED_AGREEMENT_REF` to references for that evidence.
5. Enable `credit_readiness` only for named pilot firms. Capture explicit
   Layer-3 consent, current KYB and source-complete assessments; then run the
   structural replay from the Credit control.
6. When the governance panel reports ready, enable `credit_readiness`
   platform-wide before `bank_data_room` (its manifest dependency). Verify a
   cohort below five businesses is suppressed and that served/suppressed views
   appear in the access ledger.

This sequence does not activate finance applications, pricing, offers,
disbursement, collections or repayment. Those remain R4 work and require a
separate legal, security and operational release decision.

## Human and third-party evidence

These checks cannot be truthfully completed by source code alone:

The [Valo external rollout checklist](valo-rebrand.md#external-rollout-checklist)
also requires deployment-owner verification. The project owner selected
`valo-platform.replit.app` as the replacement application domain. Replit's
publishing form confirmed availability on 2026-09-08; this is not a reservation
or evidence that the hostname cutover is complete. Keep
`advisory@meridianiq.com` until the user supplies a verified mailbox replacement.

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
   Use the [usability pilot protocol](usability-pilot.md) for the draft,
   navigation, and buyer-query tasks. A prepared protocol or automated test
   result is not evidence of completed participant sessions.
3. Obtain and retain production authority-rail accreditation evidence before
   setting `RAIL_ACCREDITATION_CONFIRMED=true`. Set `REQUIRE_LIVE_RAILS=true`
   only for a release that must use accredited live rails; it turns any
   simulator, sandbox, or partial configuration into a blocking check.
4. Before an R3 bank pilot, have the data-protection owner approve the DPIA and
   verify the cohort design against realistic sparse and adversarial data.
   Retain the signed bank MOU/DPA and collection-feed agreement, test access
   revocation with the bank, and document who may grant or renew access.

Dates are evidence attestations, not bypasses. The supporting report, mail test,
or accreditation record must exist outside the environment variable.
