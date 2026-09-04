import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  deployedBuildRevision,
  expectedBuildRevision,
  revisionsMatch,
} from "./build.ts";

const keys = [
  "BUILD_REVISION",
  "REPLIT_GIT_SHA",
  "REPLIT_DEPLOYMENT_ID",
  "GITHUB_SHA",
  "COMMIT_SHA",
  "EXPECTED_BUILD_REVISION",
  "NODE_ENV",
] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("the running revision prefers explicit and Replit Git revisions", () => {
  for (const key of keys) delete process.env[key];
  process.env.REPLIT_DEPLOYMENT_ID = "deployment-42";
  process.env.REPLIT_GIT_SHA = "abcdef1234567890";
  assert.equal(deployedBuildRevision(), "abcdef1234567890");

  process.env.BUILD_REVISION = "release-2026-09-04";
  assert.equal(deployedBuildRevision(), "release-2026-09-04");
});

test("invalid revisions fail closed", () => {
  process.env.NODE_ENV = "production";
  process.env.BUILD_REVISION = "unsafe revision";
  process.env.EXPECTED_BUILD_REVISION = "also unsafe";
  assert.equal(deployedBuildRevision(), "unknown");
  assert.equal(expectedBuildRevision(), null);
});

test("only exact identifiers or meaningful Git SHA prefixes match", () => {
  assert.equal(revisionsMatch("deployment-42", "deployment-42"), true);
  assert.equal(revisionsMatch("abcdef1234567890", "abcdef1"), true);
  assert.equal(revisionsMatch("abcdef1234567890", "a"), false);
  assert.equal(revisionsMatch("deployment-42", "deployment"), false);
});
