import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ENVIRONMENT,
  githubClient,
  mainWorkflowPath,
  positiveId,
  protection,
  selection,
  validateProducer,
} from "./release-candidate-github.mjs";
import { realPath, verifyEvidence } from "./release-candidate.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function publishingChecksumPolicy(candidate) {
  const configuration = candidate.gates?.publishingConfiguration;
  assert.ok(configuration, "Publishing checksum configuration status required");
  assert.ok(
    ["CHECKED", "UNAVAILABLE"].includes(configuration.status),
    "unsupported Publishing checksum configuration status",
  );
  if (configuration.status === "UNAVAILABLE") {
    assert.deepEqual(
      Object.keys(configuration).sort(),
      ["manualReviewRequired", "status"],
      "Publishing checksum configuration has unknown fields",
    );
    assert.equal(
      configuration.manualReviewRequired,
      true,
      "unavailable Publishing metadata requires explicit manual review",
    );
    return configuration;
  }
  assert.deepEqual(
    Object.keys(configuration).sort(),
    ["checksumSources", "manualReviewRequired", "status"],
    "Publishing checksum configuration has unknown fields",
  );
  assert.equal(
    configuration.manualReviewRequired,
    false,
    "checked Publishing metadata must not claim manual metadata review",
  );
  assert.deepEqual(
    configuration.checksumSources,
    ["secret"],
    "the Publishing checksum must have exactly one secret source; environment variables and workspace secrets are not accepted",
  );
  return configuration;
}

/**
 * The optional preparation snapshot contains key names only. It can detect a
 * duplicate before download, but cannot authenticate a Replit Publishing
 * setting. The protected GitHub environment review is therefore an explicit
 * manual attestation by a trusted reviewer. Keep the expected value (the
 * manifest checksum), candidate checksum, scope, and reviewer together in the
 * receipt, but never read or retain the secret itself.
 */
export function validatePublishingChecksumProvenance(
  candidate,
  { candidateSha256, checklistSha256, reviewer, environment } = {},
) {
  const configuration = publishingChecksumPolicy(candidate);
  assert.match(
    candidateSha256 ?? "",
    SHA256,
    "manual Publishing verification requires the exact candidate checksum",
  );
  assert.match(
    checklistSha256 ?? "",
    SHA256,
    "manual Publishing verification requires the exact checklist checksum",
  );
  assert.match(
    candidate.manifest?.sha256 ?? "",
    SHA256,
    "manual Publishing verification requires the exact manifest checksum",
  );
  assert.ok(
    environment &&
      positiveId(environment.id) &&
      environment.name === ENVIRONMENT,
    "manual Publishing verification requires the protected production handoff environment",
  );
  assert.ok(
    reviewer && positiveId(reviewer.id),
    "manual Publishing verification requires a trusted human reviewer",
  );
  assert.ok(
    typeof reviewer.login === "string" && reviewer.login.length > 0,
    "manual Publishing verification requires reviewer identity",
  );
  return {
    status: "MANUALLY_VERIFIED",
    method: "protected-environment-review",
    platformAttestation: false,
    scope: "production Publishing",
    key: "RELEASE_MANIFEST_SHA256",
    secretOnly: true,
    candidateSha256,
    checklistSha256,
    expectedSecretSha256: candidate.manifest.sha256,
    metadataStatus: configuration.status,
    environment: { id: environment.id, name: environment.name },
    reviewer: { id: reviewer.id, login: reviewer.login },
  };
}

export function validateApproval(run, reviews, environment, context) {
  assert.equal(
    context.GITHUB_ACTIONS,
    "true",
    "handoff requires GitHub protected-environment job",
  );
  assert.equal(context.GITHUB_JOB, "handoff", "wrong handoff job");
  assert.equal(
    context.GITHUB_REF,
    "refs/heads/main",
    "handoff workflow must run from main",
  );
  assert.equal(
    context.GITHUB_RUN_ATTEMPT,
    "1",
    "dispatch a fresh preparation; approval history is not attempt-bound",
  );
  assert.ok(positiveId(context.GITHUB_RUN_ID), "handoff run ID required");
  assert.equal(String(run.id), context.GITHUB_RUN_ID);
  assert.equal(run.run_attempt, 1);
  assert.ok(
    mainWorkflowPath(run.path, ".github/workflows/prepare-release.yml"),
  );
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.status, "in_progress");
  assert.equal(run.head_branch, "main");
  assert.equal(run.head_sha, context.GITHUB_SHA);
  assert.equal(run.repository?.full_name, context.GITHUB_REPOSITORY);
  assert.equal(run.head_repository?.id, run.repository?.id);
  const decisions = reviews.filter((review) =>
    review.environments?.some(
      (item) => item.id === environment.id && item.name === ENVIRONMENT,
    ),
  );
  // The documented response has no attempt or bypass discriminator. Require a
  // fresh dispatch and one explicit review; disabling admin bypass is an admin
  // prerequisite, not a field this client invents or infers from comments.
  assert.equal(
    decisions.length,
    1,
    "one explicit protected-environment approval required; absent/ambiguous history refuses",
  );
  const approval = decisions[0];
  assert.equal(approval.state, "approved", "handoff not approved");
  assert.equal(approval.user?.type, "User", "human reviewer required");
  assert.ok(positiveId(approval.user.id), "reviewer identity missing");
  assert.notEqual(approval.user.id, run.actor?.id, "self approval refused");
  assert.notEqual(
    approval.user.id,
    run.triggering_actor?.id,
    "self approval refused",
  );
  return { id: approval.user.id, login: approval.user.login };
}

export async function approveHandoff(
  options,
  client = githubClient(process.env.GITHUB_TOKEN),
  context = process.env,
) {
  const candidate = await verifyEvidence(
    options.evidence,
    options.candidateSha256,
  );
  // Reject unsupported or ambiguous metadata before producer/approval API
  // access. A valid status still requires the protected reviewer below.
  publishingChecksumPolicy(candidate);
  selection(candidate.selection);
  assert.equal(
    candidate.selection.repository,
    context.GITHUB_REPOSITORY,
    "foreign candidate repository",
  );
  const producer = await client.producer(candidate.selection);
  const artifact = validateProducer(candidate.selection, producer);
  assert.deepEqual(
    {
      id: artifact.id,
      sha256: artifact.digest.slice(7),
      bytes: artifact.size_in_bytes,
    },
    candidate.artifact,
    "producer changed before approval",
  );
  const { environment } = await protection(client, context.GITHUB_REPOSITORY);
  const endpoint = `/repos/${context.GITHUB_REPOSITORY}/actions/runs/${context.GITHUB_RUN_ID}`;
  const run = await client.json(endpoint);
  const reviews = await client.json(`${endpoint}/approvals`);
  const reviewer = validateApproval(run, reviews, environment, context);
  const publishingVerification = validatePublishingChecksumProvenance(
    candidate,
    {
      candidateSha256: options.candidateSha256,
      checklistSha256: candidate.files["checklist.md"],
      reviewer,
      environment,
    },
  );
  const receipt = {
    format: 1,
    status: "APPROVED_FOR_HANDOFF_ONLY",
    productionDeploymentAuthorized: false,
    candidateSha256: options.candidateSha256,
    checklistSha256: candidate.files["checklist.md"],
    selection: candidate.selection,
    artifact: candidate.artifact,
    manifestSha256: candidate.manifest.sha256,
    environment: { id: environment.id, name: ENVIRONMENT },
    reviewer,
    publishingVerification,
    preparation: { runId: String(run.id), attempt: 1, revision: run.head_sha },
  };
  const output = path.resolve(options.output);
  realPath(path.dirname(output));
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(
    path.join(output, "approved-handoff.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const checklist = readFileSync(
    path.join(realPath(options.evidence), "checklist.md"),
    "utf8",
  );
  const approved = `# Approved For Handoff Only\n\nCandidate SHA-256: ${options.candidateSha256}\n\nChecklist SHA-256: ${candidate.files["checklist.md"]}\n\nReviewer: ${reviewer.login} (${reviewer.id}) through ${ENVIRONMENT}.\n\nPublishing checksum verification: MANUALLY_VERIFIED for production Publishing, sole secret key RELEASE_MANIFEST_SHA256, expected value ${candidate.manifest.sha256}. This is a protected-reviewer attestation, not authenticated platform metadata; the secret value is not retained.\n\nApproval is recorded at https://github.com/${context.GITHUB_REPOSITORY}/actions/runs/${run.id}.\n\nThe unchanged checklist below remains a set of operator obligations. This receipt does not assert that its boxes were completed and does not authorize authenticated production Publish, schema changes, service startup, or governed RUN.\n\n---\n\n${checklist}`;
  writeFileSync(path.join(output, "approved-checklist.md"), approved, {
    flag: "wx",
    mode: 0o600,
  });
  return { receipt, approved };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      evidence: { type: "string" },
      "candidate-sha256": { type: "string" },
      output: { type: "string" },
    },
  });
  approveHandoff({ ...values, candidateSha256: values["candidate-sha256"] })
    .then(({ approved }) => {
      if (process.env.GITHUB_STEP_SUMMARY)
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, approved);
      console.log(
        "release-candidate: approved for handoff only; production deployment remains separately authorized",
      );
    })
    .catch(() => {
      console.error("release-candidate: handoff REFUSED");
      process.exitCode = 1;
    });
}
