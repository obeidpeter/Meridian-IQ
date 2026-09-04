import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_FLAGS,
  RETIRED_FLAGS,
  activationReleaseTag,
  validateFeatureDependencies,
  type ReleaseFlag,
} from "./releases.ts";

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
  assert.equal(activationReleaseTag(RELEASE_FLAGS.map((f) => f.key)), "R4");
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

test("a retired flag is out of the manifest and never gates the badge (D17)", () => {
  assert.ok(RETIRED_FLAGS.includes("stamp_verification"));
  for (const key of RETIRED_FLAGS) {
    assert.ok(!RELEASE_FLAGS.some((f) => f.key === key), `${key} is retired`);
  }
  // Every real R1 capability lit reaches R1 without the retired key.
  assert.equal(activationReleaseTag(keysAt(["R0", "R1"])), "R1");
});

test("a later release cannot count while an earlier one is incomplete", () => {
  // Every R2 flag lit but one R1 flag dark: still R0 — stages are cumulative.
  const lit = [
    ...keysAt(["R0"]),
    ...keysAt(["R1"]).slice(1),
    ...keysAt(["R2"]),
  ];
  assert.equal(activationReleaseTag(lit), "R0");
});

test("the release manifest has a complete acyclic dependency graph", () => {
  assert.doesNotThrow(() => validateFeatureDependencies());
  const base: Omit<ReleaseFlag, "key" | "requires"> = {
    releaseTag: "R1",
    description: "test",
    launchDefault: false,
    devDefault: false,
  };
  assert.throws(
    () =>
      validateFeatureDependencies([
        { ...base, key: "a", requires: ["missing"] },
      ]),
    /requires unknown feature missing/,
  );
  assert.throws(
    () =>
      validateFeatureDependencies([
        { ...base, key: "a", requires: ["b"] },
        { ...base, key: "b", requires: ["a"] },
      ]),
    /dependency cycle/,
  );
});
