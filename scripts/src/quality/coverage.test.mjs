import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RAISE_MARGIN,
  evaluate,
  globToRegExp,
  main,
  measureAreas,
  nodeTestArgs,
  parseLcov,
  readFloors,
  vitestArgs,
  writeFloors,
} from "./coverage.mjs";

const record = (file, lines, branches, functions = [1, 1]) =>
  [
    `SF:${file}`,
    `FNF:${functions[0]}`,
    `FNH:${functions[1]}`,
    `LF:${lines[0]}`,
    `LH:${lines[1]}`,
    `BRF:${branches[0]}`,
    `BRH:${branches[1]}`,
    "end_of_record",
  ].join("\n");

const lcov = [
  record("src/modules/auth/login.ts", [100, 90], [20, 15]),
  record("src/modules/auth/session.ts", [50, 40], [10, 5]),
  record("src/modules/auth/login.test.ts", [10, 10], [2, 2]),
  record("src/modules/pipeline/pipeline.ts", [200, 100], [40, 10]),
  record("src/lib/money.ts", [20, 20], [4, 4]),
].join("\n");

const areas = {
  auth: {
    paths: ["src/modules/auth/**"],
    // Measured 87.50 / 68.75 below: met, and within the raise margin.
    floors: { lines: 85, branches: 65 },
  },
  pipeline: {
    paths: ["src/modules/pipeline/**"],
    floors: { lines: 50, branches: 25 },
  },
};

test("lcov records aggregate per area and the larger of duplicate records wins", () => {
  const files = parseLcov(
    `${lcov}\n${record("src/modules/auth/login.ts", [40, 40], [8, 8])}`,
  );
  assert.equal(
    files.filter((f) => f.file === "src/modules/auth/login.ts").length,
    1,
  );
  const measured = measureAreas(files, areas);
  // auth: (90 + 40 + 10) / (100 + 50 + 10) lines, the test file included by
  // the glob here because the exclusion is the runner's job, not the parser's.
  assert.equal(measured.auth.files, 3);
  assert.equal(measured.auth.lines.toFixed(2), "87.50");
  assert.equal(measured.auth.branches.toFixed(2), "68.75");
  assert.equal(measured.pipeline.lines, 50);
  assert.equal(measured.pipeline.branches, 25);
});

test("globs span directories with ** and stay in one segment with *", () => {
  assert.ok(
    globToRegExp("src/modules/auth/**").test("src/modules/auth/a/b.ts"),
  );
  assert.ok(globToRegExp("src/modules/auth/**").test("src/modules/auth/a.ts"));
  assert.equal(
    globToRegExp("src/modules/*/x.ts").test("src/modules/a/b/x.ts"),
    false,
  );
  assert.ok(globToRegExp("src/modules/*/x.ts").test("src/modules/a/x.ts"));
  assert.equal(
    globToRegExp("src/lib/money.ts").test("src/lib/money.tsx"),
    false,
  );
});

test("a floor is met at equality, fails below it, and advises a raise at the margin", () => {
  const files = parseLcov(lcov);
  const measured = measureAreas(files, areas);
  const met = evaluate(measured, areas);
  assert.deepEqual(met.failures, []);
  assert.deepEqual(met.raises, []);
  const below = evaluate(measured, {
    ...areas,
    pipeline: { ...areas.pipeline, floors: { lines: 51, branches: 25 } },
  });
  assert.match(
    below.failures[0],
    /pipeline: lines 50\.00% is below the 51% floor/,
  );
  const generous = evaluate(measured, {
    ...areas,
    pipeline: {
      ...areas.pipeline,
      floors: { lines: 50 - RAISE_MARGIN, branches: 25 },
    },
  });
  assert.match(
    generous.raises[0],
    /pipeline: lines 50\.00% clears the 45% floor/,
  );
});

test("an area whose globs match nothing fails instead of passing vacuously", () => {
  const measured = measureAreas(parseLcov(lcov), {
    ghost: {
      paths: ["src/modules/ghost/**"],
      floors: { lines: 0, branches: 0 },
    },
  });
  const { failures } = evaluate(measured, {
    ghost: {
      paths: ["src/modules/ghost/**"],
      floors: { lines: 0, branches: 0 },
    },
  });
  assert.match(failures[0], /ghost: no covered files matched/);
});

test("write records the measured percentages rounded down less the tolerance, and check reads them back", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-floors-"));
  const floorsFile = path.join(dir, "coverage-floors.json");
  writeFileSync(floorsFile, JSON.stringify({ areas }, null, 2));
  const lcovFile = path.join(dir, "lcov.info");
  writeFileSync(lcovFile, lcov);
  const measured = measureAreas(parseLcov(lcov), areas);
  const next = writeFloors(floorsFile, readFloors(floorsFile), measured);
  assert.deepEqual(next.areas.auth.floors, { lines: 85, branches: 66 });
  assert.deepEqual(next.areas.pipeline.floors, { lines: 48, branches: 23 });
  assert.deepEqual(JSON.parse(readFileSync(floorsFile, "utf8")), next);
  const checked = main([
    "check",
    "--cwd",
    dir,
    "--lcov",
    lcovFile,
    "--summary",
    path.join(dir, "summary.json"),
  ]);
  assert.equal(checked.ok, true, checked.message);
  assert.match(checked.message, /coverage floors passed/);
  const summary = JSON.parse(
    readFileSync(path.join(dir, "summary.json"), "utf8"),
  );
  assert.equal(summary.areas.auth.files, 3);
  assert.deepEqual(summary.failures, []);
});

test("check refuses a malformed floors file and a missing lcov file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-floors-"));
  const floorsFile = path.join(dir, "coverage-floors.json");
  writeFileSync(
    floorsFile,
    JSON.stringify({
      areas: { auth: { paths: [], floors: { lines: 1, branches: 1 } } },
    }),
  );
  assert.throws(
    () => readFloors(floorsFile),
    /paths must be a non-empty array/,
  );
  writeFileSync(
    floorsFile,
    JSON.stringify({
      areas: {
        auth: { paths: ["src/**"], floors: { lines: 101, branches: 1 } },
      },
    }),
  );
  assert.throws(
    () => readFloors(floorsFile),
    /floors\.lines must be an integer 0-100/,
  );
  writeFileSync(floorsFile, JSON.stringify({ areas }));
  const missing = main([
    "check",
    "--cwd",
    dir,
    "--lcov",
    path.join(dir, "absent.info"),
  ]);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /is missing; run the coverage command first/);
});

test("the runner kind picks the command and each restricts coverage to the areas' globs", () => {
  const floors = {
    runner: { kind: "vitest", exclude: ["src/**/*.stories.*"] },
    areas,
  };
  const vitest = vitestArgs(floors);
  assert.deepEqual(vitest.slice(0, 3), ["exec", "vitest", "run"]);
  assert.ok(vitest.includes("--coverage.provider=v8"));
  assert.ok(vitest.includes("--coverage.reporter=lcov"));
  assert.ok(vitest.includes("--coverage.include=src/modules/auth/**"));
  assert.ok(vitest.includes("--coverage.include=src/modules/pipeline/**"));
  // Suites, shared suite bodies and browser fixtures never count as source,
  // and the floors file can name more.
  for (const glob of [
    "src/**/*.test.*",
    "src/**/*.suite.*",
    "src/**/*.browser.*",
    "src/**/*.stories.*",
  ])
    assert.ok(vitest.includes(`--coverage.exclude=${glob}`), glob);

  const node = nodeTestArgs({ areas }, "src/**/*.test.ts");
  assert.ok(node.includes("--experimental-test-coverage"));
  assert.ok(node.includes("--test-coverage-include=src/modules/auth/**"));
  assert.ok(node.includes("--test-coverage-exclude=src/**/*.test.ts"));
  assert.equal(node.at(-1), "src/**/*.test.ts");

  const dir = mkdtempSync(path.join(tmpdir(), "coverage-floors-"));
  const floorsFile = path.join(dir, "coverage-floors.json");
  writeFileSync(
    floorsFile,
    JSON.stringify({ runner: { kind: "jest" }, areas }),
  );
  assert.throws(
    () => readFloors(floorsFile),
    /runner\.kind must be node-test or vitest, not jest/,
  );
  writeFileSync(floorsFile, JSON.stringify({ areas }));
  assert.equal(readFloors(floorsFile).runner, undefined);
});
