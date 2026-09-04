import { readFileSync } from "node:fs";
import {
  displayPath,
  readText,
  sha256,
  sourceFiles,
  workspaceFiles,
} from "./shared.mjs";

const source = sourceFiles().filter((file) => {
  const path = displayPath(file);
  return !path.includes("/generated/") && !path.includes("/static-build/");
});
const rows = source.map((file) => ({
  file: displayPath(file),
  lines: readText(file).split(/\r?\n/).length,
}));
const duplicateGroups = new Map();
for (const file of source) {
  const text = readText(file).trim();
  if (text.split(/\r?\n/).length < 8) continue;
  const hash = sha256(text);
  duplicateGroups.set(hash, [
    ...(duplicateGroups.get(hash) ?? []),
    displayPath(file),
  ]);
}

let dependencies = 0;
for (const file of workspaceFiles(["."]).filter((entry) =>
  displayPath(entry).endsWith("package.json"),
)) {
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    dependencies += Object.keys(pkg.dependencies ?? {}).length;
    dependencies += Object.keys(pkg.devDependencies ?? {}).length;
  } catch {
    // A malformed package is caught by install/build; metrics remain best-effort.
  }
}

const metrics = {
  sourceFiles: rows.length,
  sourceLines: rows.reduce((sum, row) => sum + row.lines, 0),
  filesOver600Lines: rows.filter((row) => row.lines > 600).length,
  filesOver1000Lines: rows.filter((row) => row.lines > 1000).length,
  largestFiles: rows.sort((a, b) => b.lines - a.lines).slice(0, 15),
  exactDuplicateGroups: [...duplicateGroups.values()].filter(
    (group) => group.length > 1,
  ).length,
  declaredDependencyEntries: dependencies,
};

if (process.argv.includes("--json"))
  console.log(JSON.stringify(metrics, null, 2));
else {
  console.log(
    `Maintainability metrics: ${metrics.sourceFiles} files / ${metrics.sourceLines} lines.`,
  );
  console.log(
    `Oversized modules: ${metrics.filesOver600Lines} >600 lines; ${metrics.filesOver1000Lines} >1000 lines.`,
  );
  console.log(
    `Exact duplicate groups: ${metrics.exactDuplicateGroups}. Declared dependency entries: ${metrics.declaredDependencyEntries}.`,
  );
  for (const row of metrics.largestFiles)
    console.log(`${String(row.lines).padStart(5)}  ${row.file}`);
}
