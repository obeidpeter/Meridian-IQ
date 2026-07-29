import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { migrations } from "./index.ts";

// Migration-file-to-registry lockstep (refactoring round, survey item 15).
// A numbered migration file that never gets imported into index.ts is
// silently INERT — the migrator walks the registry array, not the
// directory, so a forgotten import drops a guardrail without failing
// anything. The RLS coverage test only catches the subset that leaves a
// tenant table uncovered; this pins the rest. Pure filesystem + registry
// assertions — no database.

const NUMBERED = /^(\d{4})_.+\.ts$/;

test("every numbered migration file on disk is registered exactly once", () => {
  const onDisk = readdirSync(import.meta.dirname)
    .map((f) => NUMBERED.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
  assert.ok(onDisk.length >= 28, "the migrations directory parsed");
  const registered = migrations.map((m) => m.version);
  for (const version of onDisk) {
    assert.equal(
      registered.filter((v) => v === version).length,
      1,
      `migration file ${String(version).padStart(4, "0")}_*.ts must be registered exactly once in index.ts — an unimported migration is silently inert`,
    );
  }
  for (const version of registered) {
    assert.ok(
      onDisk.includes(version),
      `registered migration ${version} has no numbered file on disk`,
    );
  }
});

test("the registry is strictly increasing in array order", () => {
  // applyMigrations trusts the ARRAY order; a mis-ordered entry would apply
  // a later guardrail before its prerequisite.
  const versions = migrations.map((m) => m.version);
  for (let i = 1; i < versions.length; i++) {
    assert.ok(
      versions[i] > versions[i - 1],
      `registry order breaks at index ${i}: ${versions[i - 1]} is followed by ${versions[i]}`,
    );
  }
});
