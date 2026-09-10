import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_E2E_CHECKS } from "../expected-count.mjs";

// R105 drift guard: the figures the engineering docs state about the build
// must match their single sources — the e2e count constant the harness
// enforces in CI, and the contract version in the OpenAPI document.
const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

test("CLAUDE.md, replit.md and the user manual state the enforced e2e check count", () => {
  // The number and the word "checks" may wrap across a line in the manual.
  const expected = new RegExp(
    `\\b${EXPECTED_E2E_CHECKS}\\b[\\s\\S]{0,60}?checks`,
  );
  for (const file of ["CLAUDE.md", "replit.md", "docs/USER_MANUAL.md"]) {
    assert.match(
      read(file),
      expected,
      `${file} must state ${EXPECTED_E2E_CHECKS} checks`,
    );
  }
});

test("CLAUDE.md and ADR 0004 describe the pilot publish path replit-promote.mjs implements (R111)", () => {
  // be150582 moved every database mutation out of the Publish build; the two
  // documents that lagged that change are pinned here so they cannot again.
  for (const file of ["CLAUDE.md", "docs/adr/0004-release-profiles.md"]) {
    const text = read(file);
    assert.match(
      text,
      /native Publish/,
      `${file} must say Replit's native Publish diff owns production tables`,
    );
    assert.doesNotMatch(
      text,
      /syncs the target schema/,
      `${file} must not describe a build-time schema push`,
    );
  }
  assert.doesNotMatch(
    read("scripts/src/ops/replit-promote.mjs"),
    /pilotSchemaSync|run push|drizzle-kit push/,
    "the promotion script must not push schema in any profile",
  );
});

test("CLAUDE.md states the contract version that lib/api-spec/openapi.yaml carries", () => {
  const version = read("lib/api-spec/openapi.yaml").match(
    /^ {2}version: (\S+)/m,
  )?.[1];
  assert.ok(version, "openapi.yaml has an info.version");
  assert.match(
    read("CLAUDE.md"),
    new RegExp(`currently \`${version.replace(/\./g, "\\.")}\``),
    `CLAUDE.md must say the contract is currently ${version}`,
  );
});
