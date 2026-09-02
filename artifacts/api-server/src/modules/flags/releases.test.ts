import { test } from "node:test";
import assert from "node:assert/strict";
import { RELEASE_FLAGS, activationReleaseTag } from "./releases.ts";

// The activation badge the shells render (Me.releaseTag) must move only on a
// COMPLETE activation of a release — a single pilot override or a partial
// roll-out never advances it — and never pretend a stage beyond the manifest.

const keysAt = (tags: string[]) =>
  RELEASE_FLAGS.filter((f) => tags.includes(f.releaseTag)).map((f) => f.key);

test("the launch profile amounts to R0 (the Field Kit core)", () => {
  const launchLit = RELEASE_FLAGS.filter((f) => f.launchDefault).map(
    (f) => f.key,
  );
  assert.equal(activationReleaseTag(launchLit), "R0");
});

test("a fully lit manifest reaches R4; nothing lit floors at R0", () => {
  assert.equal(
    activationReleaseTag(RELEASE_FLAGS.map((f) => f.key)),
    "R4",
  );
  assert.equal(activationReleaseTag([]), "R0");
  assert.equal(activationReleaseTag(["not-a-real-flag"]), "R0");
});

test("a partially activated release does not advance the stage", () => {
  const r1 = keysAt(["R1"]);
  assert.ok(r1.length >= 2, "R1 carries more than one flag");
  const allButOne = [...keysAt(["R0"]), ...r1.slice(1)];
  assert.equal(activationReleaseTag(allButOne), "R0");
  assert.equal(activationReleaseTag([...keysAt(["R0"]), ...r1]), "R1");
});

test("a later release cannot count while an earlier one is incomplete", () => {
  // Every R2 flag lit but one R1 flag dark: still R0 — stages are cumulative.
  const lit = [...keysAt(["R0"]), ...keysAt(["R1"]).slice(1), ...keysAt(["R2"])];
  assert.equal(activationReleaseTag(lit), "R0");
});
