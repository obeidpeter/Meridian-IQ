#!/usr/bin/env node
// Coverage visibility for the api-server's critical areas (R118).
//
// The floors file names the areas (auth, tenancy, money, clerk-gateway,
// pipeline) as path globs and the line and branch percentages each must
// keep. `run` executes the api-server suite under Node's built-in V8
// coverage (tsx's inline source maps carry it back to the .ts sources),
// writes coverage/lcov.info and coverage/summary.json, then checks the
// floors. `check` re-checks an existing lcov file. `write` records the
// measured percentages (rounded down, less a two-point tolerance) as the new
// floors: the ratchet moves up by hand, never down by accident, and a run
// that clears a floor by five points or more says so, so the floor is
// raised in the same change.
//
// Usage (from artifacts/api-server, or with --cwd):
//   node ../../scripts/src/quality/coverage.mjs run
//   node ../../scripts/src/quality/coverage.mjs check
//   node ../../scripts/src/quality/coverage.mjs write
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RAISE_MARGIN = 5;
// A floor sits this many points under the measured value when written, so
// run-to-run variance (timing-dependent branches, a skipped fixture) does
// not fail CI the next day; the raise advice fires at RAISE_MARGIN above the
// floor, so it only speaks once coverage has genuinely moved.
export const WRITE_MARGIN = 2;

export function parseLcov(text) {
  const files = new Map();
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      current = {
        file: line.slice(3),
        lines: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
      };
      continue;
    }
    if (!current) continue;
    const [key, value] = line.split(":");
    const number = Number(value);
    if (key === "LF") current.lines.found = number;
    else if (key === "LH") current.lines.hit = number;
    else if (key === "BRF") current.branches.found = number;
    else if (key === "BRH") current.branches.hit = number;
    else if (key === "FNF") current.functions.found = number;
    else if (key === "FNH") current.functions.hit = number;
    else if (line === "end_of_record") {
      // A file can appear more than once (one record per worker): keep the
      // record with the most lines found so a partial worker view never
      // shadows the full one.
      const previous = files.get(current.file);
      if (!previous || previous.lines.found < current.lines.found) {
        files.set(current.file, current);
      }
      current = null;
    }
  }
  return [...files.values()];
}

// Glob to RegExp: `**/` spans zero or more directories, a trailing `**`
// matches the rest of the path, `*` stays within one segment.
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const percent = (hit, found) => (found === 0 ? 100 : (hit / found) * 100);

export function measureAreas(files, areas) {
  const measured = {};
  for (const [name, area] of Object.entries(areas)) {
    const matchers = area.paths.map(globToRegExp);
    const matched = files.filter((file) =>
      matchers.some((matcher) => matcher.test(file.file)),
    );
    const sum = (key, part) =>
      matched.reduce((total, file) => total + file[key][part], 0);
    measured[name] = {
      files: matched.length,
      lines: percent(sum("lines", "hit"), sum("lines", "found")),
      branches: percent(sum("branches", "hit"), sum("branches", "found")),
      functions: percent(sum("functions", "hit"), sum("functions", "found")),
    };
  }
  return measured;
}

export function evaluate(measured, areas) {
  const failures = [];
  const raises = [];
  for (const [name, area] of Object.entries(areas)) {
    const result = measured[name];
    if (!result || result.files === 0) {
      failures.push(
        `${name}: no covered files matched ${area.paths.join(", ")}`,
      );
      continue;
    }
    for (const metric of ["lines", "branches"]) {
      const floor = area.floors[metric];
      const value = result[metric];
      if (value < floor) {
        failures.push(
          `${name}: ${metric} ${value.toFixed(2)}% is below the ${floor}% floor`,
        );
      } else if (value >= floor + RAISE_MARGIN) {
        raises.push(
          `${name}: ${metric} ${value.toFixed(2)}% clears the ${floor}% floor by ${RAISE_MARGIN}+ points; raise it (coverage write)`,
        );
      }
    }
  }
  return { failures, raises };
}

export function renderTable(measured, areas) {
  const rows = Object.entries(areas).map(([name, area]) => {
    const result = measured[name];
    return [
      name,
      String(result.files),
      `${result.lines.toFixed(2)} / ${area.floors.lines}`,
      `${result.branches.toFixed(2)} / ${area.floors.branches}`,
      result.functions.toFixed(2),
    ];
  });
  const header = [
    "area",
    "files",
    "lines % / floor",
    "branches % / floor",
    "funcs %",
  ];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  );
  const line = (cells) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

export function readFloors(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  for (const [name, area] of Object.entries(parsed.areas)) {
    if (!Array.isArray(area.paths) || area.paths.length === 0)
      throw new Error(`${name}: paths must be a non-empty array`);
    for (const metric of ["lines", "branches"]) {
      const floor = area.floors?.[metric];
      if (!Number.isInteger(floor) || floor < 0 || floor > 100)
        throw new Error(`${name}: floors.${metric} must be an integer 0-100`);
    }
  }
  return parsed;
}

export function writeFloors(file, floors, measured) {
  const next = structuredClone(floors);
  for (const [name, area] of Object.entries(next.areas)) {
    area.floors = {
      lines: Math.max(0, Math.floor(measured[name].lines) - WRITE_MARGIN),
      branches: Math.max(0, Math.floor(measured[name].branches) - WRITE_MARGIN),
    };
  }
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

function nodeArgs(floors, pattern) {
  const args = [
    "--import",
    "tsx",
    "--test",
    "--test-force-exit",
    "--test-concurrency=1",
    "--experimental-test-coverage",
    "--test-coverage-exclude=src/**/*.test.ts",
    "--test-coverage-exclude=src/test-helpers/**",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
  ];
  for (const area of Object.values(floors.areas))
    for (const glob of area.paths) args.push(`--test-coverage-include=${glob}`);
  args.push(pattern);
  return args;
}

export function main(argv, env = process.env) {
  const command = argv[0] ?? "check";
  const option = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
  };
  const cwd = path.resolve(option("--cwd", process.cwd()));
  const floorsFile = path.resolve(
    cwd,
    option("--floors", "coverage-floors.json"),
  );
  const lcovFile = path.resolve(cwd, option("--lcov", "coverage/lcov.info"));
  const summaryFile = path.resolve(
    cwd,
    option("--summary", "coverage/summary.json"),
  );
  const floors = readFloors(floorsFile);

  if (command === "run") {
    mkdirSync(path.dirname(lcovFile), { recursive: true });
    // The package's `pretest` hook seeds the release flags before `test`;
    // a direct node invocation gets no hook, so seed here the same way.
    const seed = spawnSync(
      process.execPath,
      ["--import", "tsx", "./src/test-helpers/seed-release-flags.ts"],
      { cwd, stdio: "inherit", env },
    );
    if (seed.status !== 0) {
      return {
        ok: false,
        message: `release-flag seed failed (exit ${seed.status})`,
      };
    }
    const result = spawnSync(
      process.execPath,
      nodeArgs(floors, option("--pattern", "src/**/*.test.ts")),
      { cwd, stdio: "inherit", env },
    );
    if (result.status !== 0) {
      return {
        ok: false,
        message: `api-server tests failed (exit ${result.status})`,
      };
    }
  }
  if (!existsSync(lcovFile)) {
    return {
      ok: false,
      message: `${lcovFile} is missing; run the coverage command first`,
    };
  }
  const files = parseLcov(readFileSync(lcovFile, "utf8"));
  const measured = measureAreas(files, floors.areas);
  if (command === "write") {
    const next = writeFloors(floorsFile, floors, measured);
    return {
      ok: true,
      message: `floors written to ${path.relative(cwd, floorsFile)}\n${renderTable(measured, next.areas)}`,
    };
  }
  const { failures, raises } = evaluate(measured, floors.areas);
  mkdirSync(path.dirname(summaryFile), { recursive: true });
  writeFileSync(
    summaryFile,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        areas: measured,
        failures,
        raises,
      },
      null,
      2,
    ) + "\n",
  );
  const table = renderTable(measured, floors.areas);
  if (failures.length) {
    return {
      ok: false,
      message: `${table}\n\ncoverage floors failed:\n- ${failures.join("\n- ")}`,
    };
  }
  const advice = raises.length
    ? `\n\nfloors can rise:\n- ${raises.join("\n- ")}`
    : "";
  return { ok: true, message: `${table}\n\ncoverage floors passed.${advice}` };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = main(process.argv.slice(2));
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
