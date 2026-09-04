# R198 Maintenance Forward-Fix Release Plan

## Status and Authority

This documents preparation only. It is not a deployment authorization, a drain
record, a backup approval, or an executable operator plan. Backup approval remains
pending. No production action or backup observation has been performed by adding
this module. Test fixtures contain synthetic evidence and must never be submitted
as an operator plan.

The maintenance-forward path keeps **all writers stopped until verification and
explicit operator signoff**. It never permits schema push, automatic resume, or an
automatic fallback to a rollback build. A failure leaves maintenance in place for
a reviewed forward fix. The default release mode remains `rollback`, requiring
the existing compatible full `RELEASE_ROLLBACK_REVISION` SHA.

## Integration Contract

`scripts/src/ops/recovery-plan.mjs` has no SQL, subprocesses, network operations,
environment mutations, or file writes. Importing it performs no action. Exports:

```js
recoveryMode(env); // "rollback" (default) or "maintenance-forward"
loadMaintenancePlan(env, { revision, backupSha256, now }); // validated plan
validateMaintenancePlan(plan, {
  revision,
  backupSha256,
  now,
  trafficDrained,
}); // pure validation; not a substitute for trusted file loading
```

`now` is optional epoch milliseconds, defaulting to the real clock. Only tests
should override it. `revision` comes from the already verified immutable build
manifest. `backupSha256` comes from independently validated recovery evidence for
the actual pre-change backup archive, not from the plan itself. The return value
is the parsed plan, not authorization to perform or resume any operation.

Parent/E owns release integration, without changing `releaseOptions`' existing
`{ offline }` return shape:

1. Call `recoveryMode(env)` in options validation. It rejects unknown modes,
   checks the rollback SHA in default mode, and in maintenance mode requires the
   plan path, independently trusted digest and exact drain environment flag.
2. Reject `--offline-bootstrap` in maintenance-forward mode. This maintenance
   path must never execute schema push.
3. Load/verify the build manifest and validate recovery evidence. Pass its actual
   backup archive SHA to `loadMaintenancePlan` before any catalog operation or
   release command. Do not substitute the backup manifest's hash for archive SHA.
4. Retain all existing backup/restore, artifact and catalog verification gates.
   Log the approved plan digest and candidate identity for the release record;
   avoid dumping operator evidence or secrets to logs.
5. Revalidate with the real current time immediately before mutation if other
   preflight work took time. A validation result is not a lasting execution or
   resume permit. Expiry or failure means keep all writers stopped. A new fix
   candidate requires a newly reviewed, exact-SHA-bound plan and trusted digest.

Required maintenance environment variables:

| Variable                       | Meaning                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `RELEASE_RECOVERY_MODE`        | Exactly `maintenance-forward`; omission means rollback.                                                     |
| `RELEASE_RECOVERY_PLAN`        | Readable local regular JSON file; no leaf symlink.                                                          |
| `RELEASE_RECOVERY_PLAN_SHA256` | Lowercase 64-hex SHA-256 of the exact approved file bytes, obtained independently from the approval record. |
| `RELEASE_TRAFFIC_DRAINED`      | Exactly `1`, set only after all API, worker, schedule and other-writer drain observations.                  |

Do not derive the trusted digest automatically from the file in the release
command. An approver must review the completed observations and publish the
digest through a separately trusted change-control channel. SHA binding prevents
undetected content substitution; it does not authenticate a human, prove drain,
verify a backup, or make an arbitrary self-signed record trustworthy.

## Schema Version 1

All listed fields are required; unknown fields are rejected. The maximum file
size is 64 KiB, measured during the read as well as from file metadata. The file
must be valid UTF-8 JSON without a BOM. Timestamps use UTC
`YYYY-MM-DDTHH:mm:ssZ` or `YYYY-MM-DDTHH:mm:ss.SSSZ`. Text is trimmed, nonempty,
control-character-free and at most 2,000 characters unless noted below.

| Field        | Required value / structure                                                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`     | Integer `1`.                                                                                                                                       |
| `mode`       | Exactly `maintenance-forward`.                                                                                                                     |
| `revision`   | Exact lowercase 40-hex candidate commit SHA, matching verified manifest.                                                                           |
| `approved`   | Boolean `true`, not a string or generic chat approval.                                                                                             |
| `approvedBy` | Approver identity, maximum 200 characters.                                                                                                         |
| `approvedAt` | Actual approval timestamp, no future value and at most one hour old.                                                                               |
| `window`     | Object containing `start` and `end`; positive duration at most four hours, `start <= now < end`.                                                   |
| `drain`      | Object containing `confirmedBy`, `confirmedAt`, `api`, `workers`, `schedules`, `otherWriters`.                                                     |
| `backup`     | Object containing `sha256`, `preChange: true`, `completedAt`, `evidence`. SHA must equal the independently verified pre-change backup archive SHA. |
| `forwardFix` | Object containing `approved: true`, `owner`, `procedure`, `writersRemainStopped: true`, `automaticResume: false`, `resumeCriteria`.                |

`drain.confirmedBy` and `forwardFix.owner` are identities of at most 200
characters. `confirmedAt` means every inventory below was observed stopped or
absent, not that a stop was merely requested. Required chronological ordering:

```text
window.start <= drain.confirmedAt <= backup.completedAt <= approvedAt <= now < window.end
```

The backup must be the pre-change snapshot taken while writers are stopped, not
an unrelated earlier heartbeat or a backup of an already partially migrated
database. Completion after drain alone cannot establish this; the independent
backup evidence and operator review must establish its source and snapshot time.
Preserve the immutable archive and its original digest throughout forward-fix
recovery; never relabel a post-change backup as the approved baseline.

Each of the four drain inventory objects contains exactly:

| Field      | Required value                                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `state`    | `stopped`, or `absent` only for workers, schedules or other writers. API must be stopped.                                           |
| `targets`  | Up to 64 unique target identifiers of at most 200 characters; nonempty for stopped groups, empty for absent groups.                 |
| `evidence` | Observation record/reference identifying the target inventory and confirming no in-flight writers; required even for absent groups. |

Inventory every API replica and background writer, including in-process jobs,
queue consumers, scheduled triggers, retry processes, provider/webhook ingress,
administrative jobs and other direct database clients. A paused schedule alone
does not stop an already running job. Evidence must address both new work and
in-flight drain. Do not record `absent` merely because a category was not checked.

`forwardFix.procedure` names the reviewed offline diagnosis, repair and escalation
procedure; it is data, never executed as a command by this module.
`forwardFix.resumeCriteria` contains exactly these nonempty criteria:

| Criterion            | Approval must require                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `artifactIdentity`   | Verified immutable build and full SHA for the final candidate.                                          |
| `migrationIntegrity` | Versioned migration results, retained data/evidence checks and no unreviewed schema changes.            |
| `securityCatalog`    | Expected roles, grants, RLS policies, triggers and constraints.                                         |
| `applicationChecks`  | Required release/postdeploy and isolated application checks without reopening writers prematurely.      |
| `operatorSignoff`    | Named accountable operator records verification evidence and explicitly authorizes the resume sequence. |

The validator checks presence and bindings, not the semantic adequacy of prose
criteria or completion of these checks. The approver must reject vague criteria.
Plan acceptance alone cannot satisfy postdeploy checks or authorize resuming any
writer. Verification that itself needs database writes must be separately
authorized and narrowly controlled; never restart background production work just
to run a health check.

## Preparation and Failure Handling

Draft the procedure and inventory outside an operational plan first. After backup
authorization, actual external drain and observed immutable backup completion,
populate the evidence, have the operator approve that exact record, and publish
its digest independently. General approval to prepare a deployment is not enough.
This repository intentionally contains no populated maintenance operator plan.

On any refusal, timeout, verification failure or window expiry, keep maintenance
and the external writer blocks in place. Preserve the original backup and failed
candidate evidence. Obtain a new bounded approval before another attempt; forward
fixes must not silently switch to an incompatible rollback or resume on error.
None of the functions in this module creates backups, stops traffic, migrates,
deploys, restores, or resumes anything.

Pure verification command (temporary synthetic files only, no database):

```sh
node --test scripts/src/ops/recovery-plan.test.mjs
```
