// Sidecar only: authenticated CI transport -> isolated source -> existing gates.
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { digest } from "./build-manifest.mjs";
import { run, sha256File } from "./common.mjs";
import { REPLIT_APPS } from "./replit-promote.mjs";
import {
  githubClient,
  selection,
  validateProducer,
  protection,
} from "./release-candidate-github.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVIDENCE_FILES = [
  "candidate.json",
  "checklist.md",
  "gates.log",
  "inventory.json",
  "original.zip",
  "provenance.json",
];

export function realPath(file, directory = true) {
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute
    .slice(root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, part);
    const info = lstatSync(current);
    assert.equal(info.isSymbolicLink(), false, "symlink/reparse path refused");
    assert.ok(
      current === absolute && !directory ? info.isFile() : info.isDirectory(),
      "non-regular path refused",
    );
  }
  return absolute;
}

export function safeRelative(file) {
  assert.ok(
    typeof file === "string" && file.length > 0 && file.length <= 1024,
    "invalid relative path",
  );
  for (const part of file.split("/")) {
    assert.match(part, /^[A-Za-z0-9_@+.,()[\] -]+$/, "unsafe relative path");
    assert.ok(
      ![".", "..", ".git"].includes(part.toLowerCase()) &&
        !/[. ]$/.test(part) &&
        !part.startsWith(" "),
      "ambiguous path component",
    );
    assert.ok(
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i.test(part),
      "reserved path component",
    );
  }
  return file;
}

export function processEnvironment(environment = process.env) {
  // No DATABASE_URL, provider credentials, Node preload, Git overrides, or .env
  // loading. Git is local-only; no checkout hooks or configured external filters.
  const allowed = new Set([
    "path",
    "systemroot",
    "windir",
    "temp",
    "tmp",
    "tmpdir",
    "pathext",
  ]);
  const clean = Object.fromEntries(
    Object.entries(environment).filter(([key]) =>
      allowed.has(key.toLowerCase()),
    ),
  );
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    PYTHONNOUSERSITE: "1",
  };
}

function command(binary, args, cwd, environment = processEnvironment()) {
  const result = run(binary, args, { cwd, env: environment, timeout: 300000 });
  assert.equal(
    result.status,
    0,
    `${path.basename(binary)} release preparation command refused: ${result.stderr?.trim() || "non-zero exit"}`,
  );
  return result.stdout;
}

export function inspectArchive(archive, python, destination) {
  realPath(archive, false);
  return JSON.parse(
    command(
      python,
      [
        "-I",
        path.join(HERE, "release-candidate-archive.py"),
        archive,
        ...(destination ? [destination] : []),
      ],
      HERE,
    ),
  );
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

export function reserveOutput(source, output) {
  source = realPath(source);
  output = path.resolve(output);
  realPath(path.dirname(output));
  assert.ok(
    !within(source, output) && !within(output, source),
    "staging must be separate from development checkout",
  );
  assert.ok(
    !existsSync(output),
    "output already exists; no merging or overwrite",
  );
  mkdirSync(output, { mode: 0o700 });
  return { source, output, identity: lstatSync(output) };
}

function removeOwned(reservation, name) {
  assert.ok(["source", "unpacked", "git-template"].includes(name));
  const parent = realPath(reservation.output);
  const current = lstatSync(parent);
  assert.equal(
    current.dev,
    reservation.identity.dev,
    "output ownership changed",
  );
  assert.equal(
    current.ino,
    reservation.identity.ino,
    "output ownership changed",
  );
  const target = path.resolve(parent, name);
  assert.equal(
    path.dirname(target),
    parent,
    "cleanup outside reserved output refused",
  );
  if (existsSync(target)) {
    realPath(target);
    rmSync(target, { recursive: true, force: true });
  }
}

export function verifyManifestBinding(report, input) {
  const wanted = selection(input);
  assert.equal(
    report.manifest.source?.revision,
    wanted.revision,
    "manifest source differs from producer",
  );
  assert.equal(
    report.manifest.ci?.repository,
    wanted.repository,
    "manifest repository differs from producer",
  );
  assert.equal(
    String(report.manifest.ci?.runId),
    wanted.runId,
    "manifest run differs from producer",
  );
  assert.equal(
    String(report.manifest.ci?.attempt),
    wanted.attempt,
    "manifest attempt differs from producer",
  );
}

export function stageSource(reservation, revision) {
  const template = path.join(reservation.output, "git-template");
  mkdirSync(template);
  const staging = path.join(reservation.output, "source");
  command(
    "git",
    [
      "-c",
      "protocol.file.allow=always",
      "clone",
      "--no-local",
      "--no-checkout",
      // Persist only in the isolated clone so checkout and later gates agree.
      "--config=core.longpaths=true",
      `--template=${template}`,
      "--",
      reservation.source,
      staging,
    ],
    reservation.output,
  );
  const git = (args) =>
    command(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        `core.hooksPath=${template}`,
        ...args,
      ],
      staging,
    );
  // Inspect tree modes before checkout: core.symlinks=false would otherwise turn
  // a committed symlink into an apparently ordinary file on Windows.
  const entries = git(["ls-tree", "-r", "-z", revision])
    .split("\0")
    .filter(Boolean);
  assert.ok(entries.length > 0, "empty source tree");
  const aliases = new Map();
  for (const entry of entries) {
    const match = entry.match(/^(100644|100755) blob [a-f0-9]{40}\t(.+)$/s);
    assert.ok(match, "source symlinks, submodules, and special modes refused");
    const name = safeRelative(match[2]);
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const component = parts.slice(0, i).join("/");
      assert.equal(
        aliases.get(component.toLowerCase()) ?? component,
        component,
        "case-colliding source path",
      );
      aliases.set(component.toLowerCase(), component);
    }
    assert.ok(
      !/^artifacts\/[^/]+\/dist(?:\/|$)/.test(name) &&
        !name.startsWith("release/"),
      "source overlaps reserved package paths",
    );
  }
  git(["checkout", "--detach", revision]);
  assert.equal(
    git(["rev-parse", "HEAD"]).trim(),
    revision,
    "checkout differs from producer",
  );
  git(["remote", "remove", "origin"]);
  return staging;
}

export function runArtifactGates(staging, manifestHash) {
  const code = `import { promoteReplit } from ${JSON.stringify(pathToFileURL(path.join(HERE, "replit-promote.mjs")).href)}; promoteReplit(process.argv[1], process.env, process.cwd());`;
  const env = {
    ...processEnvironment(),
    RELEASE_PROFILE: "pilot",
    RELEASE_RUNTIME_STATE: "RUN",
    RELEASE_MANIFEST_SHA256: manifestHash,
  };
  return REPLIT_APPS.map((app) =>
    command(
      process.execPath,
      ["--input-type=module", "-e", code, app],
      staging,
      env,
    ),
  ).join("");
}

export function checklist(candidate) {
  const { selection: chosen, artifact, manifest, files } = candidate;
  return (
    `# Release Candidate Checklist\n\nStatus: PREPARED, NOT APPROVED. Production deployment is NOT authorized.\n\n` +
    `- Source: ${chosen.revision}\n- CI: https://github.com/${chosen.repository}/actions/runs/${chosen.runId}/attempts/${chosen.attempt}\n` +
    `- Producer artifact ID: ${artifact.id}\n- Original archive SHA-256: ${artifact.sha256}\n- Manifest SHA-256: ${manifest.sha256}\n` +
    `- Contract: ${JSON.stringify(manifest.contractVersion)}\n- Source tree: ${manifest.source.tree}\n- Source bytes: ${manifest.source.sha256}\n- Schema bytes: ${manifest.source.schemaSha256}\n` +
    `- Transport inventory SHA-256: ${files["inventory.json"]}\n- Gate evidence SHA-256: ${files["gates.log"]}\n\n` +
    `## Settings To Review\n\n` +
    `- [ ] All seven apps use the same original archive and matching-source isolated checkout. No development watcher, install, rebuild, or old dist merge.\n` +
    `- [ ] RELEASE_PROFILE=pilot and RELEASE_RUNTIME_STATE=RUN are explicitly approved for the intended target. This is not a governed RUN permit.\n` +
    `- [ ] RELEASE_MANIFEST_SHA256=${manifest.sha256}\n` +
    `- [ ] BUILD_REVISION and EXPECTED_BUILD_REVISION resolve to ${chosen.revision} at startup.\n` +
    `- [ ] Review source .replit, each service's .replit, and production target against mobile identity: ${JSON.stringify(manifest.mobile)}. Provider REPL_ID is not target attestation.\n` +
    `- [ ] Production secrets and database are isolated from development/staging. No secret values or business data enter this evidence or CI. Review one-time bootstrap settings in the secret store.\n` +
    `- [ ] Replit Publish development-data copying is OFF. Verify the setting before Publish; never copy development data into production.\n` +
    `- [ ] PUBLIC_APP_URL is the correct live HTTPS origin for the operator-approved production target, not a development preview, localhost, or staging origin. Verify it in production settings; this tool does not configure it.\n` +
    `- [ ] Native Replit Publish schema diff and rename/destructive decisions receive separate explicit operator confirmation. No schema push or migrations from this preparation tool.\n` +
    `- [ ] Backups and qualified fallback are reviewed under docs/operations.md. Governed releases retain every existing backup, catalog, HOLD, evidence, and activation-permit requirement.\n` +
    `- [ ] Protected-environment reviewer approves this candidate/checklist checksum for handoff. Authenticated production Publish requires a separate explicit approval.\n` +
    `- [ ] After that separate deployment: verify /api/readyz, source/contract health, and existing ops:postdeploy with authorized target credentials outside CI.\n`
  );
}

export async function prepareCandidate(options, dependencies = {}) {
  const chosen = selection(options);
  const client = dependencies.client ?? githubClient(process.env.GITHUB_TOKEN);
  const producer = await client.producer(chosen);
  const artifact = validateProducer(chosen, producer);
  if (options.dryRun)
    return {
      status: "DRY_RUN",
      selection: chosen,
      artifactId: artifact.id,
      archiveSha256: artifact.digest.slice(7),
      gatesRun: false,
      approved: false,
    };
  const reservation = reserveOutput(options.source, options.output);
  const evidence = path.join(reservation.output, "evidence");
  mkdirSync(evidence, { mode: 0o700 });
  const write = (file, value) =>
    writeFileSync(path.join(evidence, file), value, {
      flag: "wx",
      mode: 0o600,
    });
  const json = (file, value) =>
    write(file, JSON.stringify(value, null, 2) + "\n");
  let archiveVerified = false;
  let phase = "producer-evidence";
  try {
    json("provenance.json", producer);
    const archive = path.join(evidence, "original.zip");
    phase = "download";
    await client.download(chosen.repository, artifact, archive);
    // Recheck independently even when a transport adapter is supplied.
    assert.equal(
      lstatSync(archive).size,
      artifact.size_in_bytes,
      "archive size mismatch",
    );
    assert.equal(
      await sha256File(archive),
      artifact.digest.slice(7),
      "archive checksum mismatch",
    );
    archiveVerified = true;
    phase = "package-verification";
    const report = inspectArchive(
      archive,
      options.python ?? (process.platform === "win32" ? "python" : "python3"),
    );
    verifyManifestBinding(report, chosen);
    phase = "source-staging";
    const staging = stageSource(reservation, chosen.revision);
    phase = "package-staging";
    const unpacked = path.join(reservation.output, "unpacked");
    const extracted = inspectArchive(
      archive,
      options.python ?? (process.platform === "win32" ? "python" : "python3"),
      unpacked,
    );
    assert.deepEqual(extracted, report, "archive changed during extraction");
    for (const item of report.files) {
      const relative = safeRelative(item.file);
      const destination = path.join(staging, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      realPath(path.dirname(destination));
      copyFileSync(
        realPath(path.join(unpacked, relative), false),
        destination,
        constants.COPYFILE_EXCL,
      );
      assert.equal(
        await sha256File(destination),
        item.sha256,
        "staged transport bytes differ",
      );
    }
    removeOwned(reservation, "unpacked");
    json("inventory.json", {
      files: report.files,
      transportOnlySourceMaps: report.transportOnlySourceMaps,
    });
    phase = "artifact-gates";
    write("gates.log", runArtifactGates(staging, report.manifestSha256));
    phase = "producer-recheck";
    const current = await client.producer(chosen);
    assert.deepEqual(
      validateProducer(chosen, current),
      artifact,
      "producer artifact changed during preparation",
    );
    phase = "evidence-finalization";
    const files = {};
    for (const name of [
      "original.zip",
      "provenance.json",
      "inventory.json",
      "gates.log",
    ])
      files[name] = await sha256File(path.join(evidence, name));
    const candidate = {
      format: 1,
      status: "PREPARED",
      approved: false,
      productionDeploymentAuthorized: false,
      selection: chosen,
      artifact: {
        id: artifact.id,
        sha256: artifact.digest.slice(7),
        bytes: artifact.size_in_bytes,
      },
      manifest: {
        sha256: report.manifestSha256,
        source: report.manifest.source,
        contractVersion: report.manifest.contractVersion,
        mobile: report.manifest.mobile,
      },
      gates: {
        applications: REPLIT_APPS,
        profile: "pilot",
        runtimeState: "RUN",
        artifactOnly: true,
        serviceStarted: false,
        databaseAccess: false,
      },
      files,
    };
    write("checklist.md", checklist(candidate));
    files["checklist.md"] = await sha256File(
      path.join(evidence, "checklist.md"),
    );
    json("candidate.json", candidate);
    removeOwned(reservation, "git-template");
    return {
      status: "PREPARED",
      output: reservation.output,
      staging,
      evidence,
      candidateSha256: await sha256File(path.join(evidence, "candidate.json")),
      approved: false,
    };
  } catch (error) {
    const cleanupFailures = [];
    for (const name of ["source", "unpacked", "git-template"]) {
      try {
        removeOwned(reservation, name);
      } catch {
        cleanupFailures.push(name);
      }
    }
    // Preserve exact downloaded bytes and producer evidence, but never an apparently
    // valid staging tree. Do not persist exception text, which may contain secrets.
    json("failure.json", {
      status: "FAILED",
      phase,
      approved: false,
      archiveVerified,
      stagingRemoved: cleanupFailures.length === 0,
      cleanupFailures,
    });
    error.releaseCandidatePhase = phase;
    throw error;
  }
}

export async function verifyEvidence(directory, expectedHash) {
  directory = realPath(directory);
  assert.match(
    expectedHash ?? "",
    /^[a-f0-9]{64}$/,
    "trusted candidate checksum required",
  );
  assert.deepEqual(
    readdirSync(directory).sort(),
    [...EVIDENCE_FILES].sort(),
    "missing or extra handoff evidence",
  );
  for (const name of EVIDENCE_FILES)
    realPath(path.join(directory, name), false);
  const bytes = readFileSync(path.join(directory, "candidate.json"));
  assert.equal(digest(bytes), expectedHash, "candidate checksum mismatch");
  const candidate = JSON.parse(bytes);
  assert.equal(candidate.format, 1);
  assert.equal(candidate.status, "PREPARED");
  assert.equal(candidate.approved, false);
  assert.equal(candidate.productionDeploymentAuthorized, false);
  assert.deepEqual(
    Object.keys(candidate.files).sort(),
    EVIDENCE_FILES.filter((name) => name !== "candidate.json").sort(),
  );
  for (const [name, hash] of Object.entries(candidate.files)) {
    assert.equal(
      await sha256File(path.join(directory, name)),
      hash,
      "retained evidence checksum mismatch",
    );
  }
  return candidate;
}

async function main() {
  const { values } = parseArgs({
    options: {
      repository: { type: "string" },
      "run-id": { type: "string" },
      attempt: { type: "string" },
      revision: { type: "string" },
      source: { type: "string" },
      output: { type: "string" },
      python: { type: "string" },
      "dry-run": { type: "boolean" },
      "check-protection": { type: "boolean" },
    },
  });
  const client = githubClient(process.env.GITHUB_TOKEN);
  if (values["check-protection"]) {
    selection({
      repository: values.repository,
      runId: values["run-id"],
      attempt: values.attempt,
      revision: values.revision,
    });
    await protection(client, values.repository);
  }
  const result = await prepareCandidate(
    { ...values, runId: values["run-id"], dryRun: values["dry-run"] },
    { client },
  );
  console.log(JSON.stringify(result));
  if (process.env.GITHUB_OUTPUT && result.candidateSha256) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `candidate_sha256=${result.candidateSha256}\n`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY && result.evidence) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Candidate SHA-256: ${result.candidateSha256}\n\n`,
    );
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      readFileSync(path.join(result.evidence, "checklist.md")),
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      `release-candidate: REFUSED (${error.releaseCandidatePhase ?? "selection or configuration"}); no production action authorized`,
    );
    process.exitCode = 1;
  });
}
