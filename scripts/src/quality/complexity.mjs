#!/usr/bin/env node
// Complexity report and ratchet (R122).
//
// `report` (the default) lists the functions whose cyclomatic complexity
// exceeds 10, the count over 20 and the maximum, as it always has. `check`
// compares every function over the baseline's threshold with
// complexity-baseline.json at the repository root and fails on a hotspot
// the baseline does not carry (a new function over the threshold, or a
// file the baseline has never seen) or on a function that has grown past
// its recorded value; a function that has come down is reported as a
// baseline entry that can tighten. `write` records the measured hotspots as
// the new baseline, so the ratchet moves down by hand and never up by
// accident.
//
// Entries are keyed by file and by ESLint's label for the function
// ("Function 'name'", "Method 'name'", "Arrow function"), not by line, so
// an edit above a function does not move its entry. Several functions with
// the same label in one file (anonymous arrows, mostly) are compared
// pairwise in descending order.
//
// Usage (from the repository root or the scripts package):
//   node scripts/src/quality/complexity.mjs report [--json]
//   node scripts/src/quality/complexity.mjs check
//   node scripts/src/quality/complexity.mjs write
import { ESLint } from "eslint";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { displayPath, ROOT } from "./shared.mjs";

export const BASELINE_FILE = path.join(ROOT, "complexity-baseline.json");
export const REPORT_THRESHOLD = 10;
export const DEFAULT_THRESHOLD = 20;

// "Function 'submit' has a complexity of 25. Maximum allowed is 10." keeps
// its function label and its number.
export function parseFinding(message) {
  const match = message.match(/^(.*?) has a complexity of (\d+)\./);
  if (!match) return null;
  return { label: match[1], complexity: Number(match[2]) };
}

export async function measure() {
  const eslint = new ESLint({
    cwd: ROOT,
    overrideConfig: {
      rules: { complexity: ["warn", REPORT_THRESHOLD] },
    },
  });
  const results = await eslint.lintFiles([
    "artifacts/**/*.{ts,tsx}",
    "lib/**/*.{ts,tsx}",
  ]);
  const findings = [];
  for (const result of results) {
    for (const message of result.messages) {
      if (message.ruleId !== "complexity") continue;
      const parsed = parseFinding(message.message);
      if (!parsed) continue;
      findings.push({
        file: displayPath(result.filePath),
        line: message.line,
        ...parsed,
      });
    }
  }
  findings.sort((a, b) => b.complexity - a.complexity);
  return findings;
}

export function renderReport(findings) {
  return {
    functionsOver10: findings.length,
    functionsOver20: findings.filter((finding) => finding.complexity > 20)
      .length,
    maximum: findings[0]?.complexity ?? 0,
    highest: findings.slice(0, 20),
  };
}

// file -> label -> complexities in descending order, over the threshold.
export function hotspots(findings, threshold) {
  const files = {};
  for (const finding of findings) {
    if (finding.complexity <= threshold) continue;
    const labels = (files[finding.file] ??= {});
    (labels[finding.label] ??= []).push(finding.complexity);
  }
  const sorted = {};
  for (const file of Object.keys(files).sort()) {
    sorted[file] = {};
    for (const label of Object.keys(files[file]).sort()) {
      sorted[file][label] = files[file][label].sort((a, b) => b - a);
    }
  }
  return sorted;
}

export function readBaseline(file = BASELINE_FILE) {
  if (!existsSync(file)) {
    throw new Error(
      `${displayPath(file)} is missing; run "pnpm run complexity:write" to record the baseline`,
    );
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Number.isInteger(parsed.threshold) || parsed.threshold < 1)
    throw new Error("threshold must be a positive integer");
  if (!parsed.files || typeof parsed.files !== "object")
    throw new Error("files must be an object keyed by path");
  for (const [file, labels] of Object.entries(parsed.files)) {
    for (const [label, values] of Object.entries(labels)) {
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        values.some((value) => !Number.isInteger(value))
      )
        throw new Error(`${file}: ${label} must list integer complexities`);
    }
  }
  return parsed;
}

export function compare(baseline, findings) {
  const threshold = baseline.threshold;
  const current = hotspots(findings, threshold);
  const failures = [];
  const tightenable = [];
  // Positions are matched pairwise in descending order, so the line for a
  // message is the finding at that position among the file's same-labelled
  // functions.
  const lineOf = (file, label, position) =>
    findings
      .filter(
        (finding) =>
          finding.file === file &&
          finding.label === label &&
          finding.complexity > threshold,
      )
      .sort((a, b) => b.complexity - a.complexity)[position]?.line;
  for (const [file, labels] of Object.entries(current)) {
    for (const [label, values] of Object.entries(labels)) {
      const allowed = baseline.files[file]?.[label] ?? [];
      values.forEach((value, position) => {
        const where = `${file}:${lineOf(file, label, position)} ${label}`;
        if (position >= allowed.length) {
          failures.push(
            `${where} has complexity ${value}, over the ${threshold} threshold and not in the baseline`,
          );
        } else if (value > allowed[position]) {
          failures.push(
            `${where} has complexity ${value}, above its baseline of ${allowed[position]}`,
          );
        } else if (value < allowed[position]) {
          tightenable.push(
            `${where} measures ${value} against a baseline of ${allowed[position]}`,
          );
        }
      });
    }
  }
  for (const [file, labels] of Object.entries(baseline.files)) {
    for (const [label, values] of Object.entries(labels)) {
      const measured = current[file]?.[label] ?? [];
      for (let position = measured.length; position < values.length; position++)
        tightenable.push(
          `${file} ${label} (baseline ${values[position]}) is no longer over the threshold`,
        );
    }
  }
  return { threshold, failures, tightenable };
}

// One line per label: `"Function 'submit'": [25, 21]` reads and diffs better
// than one number per line.
export function formatBaseline(baseline) {
  return (
    JSON.stringify(baseline, null, 2).replace(
      /\[\s+([\d,\s]+?)\s+\]/g,
      (_, inner) => `[${inner.replace(/\s+/g, " ").trim()}]`,
    ) + "\n"
  );
}

export function writeBaseline(findings, threshold, file = BASELINE_FILE) {
  const next = { threshold, files: hotspots(findings, threshold) };
  writeFileSync(file, formatBaseline(next));
  return next;
}

export async function main(argv) {
  const command = argv.find((arg) => !arg.startsWith("--")) ?? "report";
  const findings = await measure();
  if (command === "report") {
    const report = renderReport(findings);
    if (argv.includes("--json")) {
      return { ok: true, message: JSON.stringify(report, null, 2) };
    }
    const lines = [
      `Complexity report: ${report.functionsOver10} functions >10; ${report.functionsOver20} >20; maximum ${report.maximum}.`,
      ...report.highest.map(
        (finding) =>
          `${String(finding.complexity).padStart(3)}  ${finding.file}:${finding.line}`,
      ),
    ];
    return { ok: true, message: lines.join("\n") };
  }
  if (command === "write") {
    const threshold = existsSync(BASELINE_FILE)
      ? readBaseline().threshold
      : DEFAULT_THRESHOLD;
    const next = writeBaseline(findings, threshold);
    const entries = Object.values(next.files).reduce(
      (total, labels) =>
        total +
        Object.values(labels).reduce((sum, values) => sum + values.length, 0),
      0,
    );
    return {
      ok: true,
      message: `baseline written to ${displayPath(BASELINE_FILE)}: ${entries} functions over ${threshold} in ${Object.keys(next.files).length} files`,
    };
  }
  if (command !== "check") {
    return { ok: false, message: `unknown command ${command}` };
  }
  const baseline = readBaseline();
  const { threshold, failures, tightenable } = compare(baseline, findings);
  const report = renderReport(findings);
  const summary = `Complexity: ${report.functionsOver10} functions >10; ${report.functionsOver20} >20; maximum ${report.maximum}; ratchet threshold ${threshold}.`;
  if (failures.length) {
    return {
      ok: false,
      message: `${summary}\n\ncomplexity ratchet failed:\n- ${failures.join("\n- ")}\n\nBring the function back under its baseline, or split it; a deliberate new hotspot is accepted with "pnpm run complexity:write".`,
    };
  }
  const advice = tightenable.length
    ? `\n\nbaseline can tighten (${tightenable.length} entries; run "pnpm run complexity:write"):\n- ${tightenable.join("\n- ")}`
    : "";
  return { ok: true, message: `${summary}\n\ncomplexity ratchet passed.${advice}` };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await main(process.argv.slice(2));
  console.log(result.message);
  process.exitCode = result.ok ? 0 : 1;
}
