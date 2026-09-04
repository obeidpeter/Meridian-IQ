import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  displayPath,
  readText,
  ROOT,
  sourceFiles,
  workspaceFiles,
} from "./shared.mjs";

const required = [
  "README.md",
  "CONTRIBUTING.md",
  ".env.example",
  "docs/architecture.md",
  "docs/development.md",
  "docs/environment.md",
  "docs/operations.md",
  "docs/repository-map.md",
  "docs/troubleshooting.md",
  "docs/adr/README.md",
  "docs/maintainability/baseline-2026-09-04.md",
  "docs/maintainability/technical-debt-register.md",
  "docs/maintainability/final-report.md",
];
const findings = required
  .filter((path) => !existsSync(join(ROOT, path)))
  .map((path) => `missing required document ${path}`);

const map = existsSync(join(ROOT, "docs/repository-map.md"))
  ? readText(join(ROOT, "docs/repository-map.md"))
  : "";
for (const file of workspaceFiles().filter((path) =>
  path.endsWith("package.json"),
)) {
  const name = JSON.parse(readText(file)).name;
  if (name?.startsWith("@workspace/") && !map.includes(`\`${name}\``)) {
    findings.push(`docs/repository-map.md does not name workspace ${name}`);
  }
}

const envNames = new Set([
  "SCHEDULED_WORK_MAX_AGE_MS",
  "BACKUP_MAX_AGE_MS",
  "RESTORE_DRILL_MAX_AGE_MS",
  "OUTBOX_RELEASE_MAX_AGE_SECONDS",
  "ADVISORY_INBOX_MAX_AGE_MS",
  "USABILITY_MAX_AGE_MS",
]);
for (const file of sourceFiles()) {
  const path = displayPath(file);
  if (path.includes("/generated/") || path.includes("/static-build/")) continue;
  const source = readText(file);
  for (const match of source.matchAll(
    /process\.env\.([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])/g,
  ))
    envNames.add(match[1]);
  for (const match of source.matchAll(
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  ))
    envNames.add(match[1]);
}
const envDoc = existsSync(join(ROOT, "docs/environment.md"))
  ? readText(join(ROOT, "docs/environment.md"))
  : "";
for (const name of [...envNames].sort()) {
  if (!envDoc.includes(`\`${name}\``))
    findings.push(`docs/environment.md does not document ${name}`);
}

const readme = existsSync(join(ROOT, "README.md"))
  ? readText(join(ROOT, "README.md"))
  : "";
for (const match of readme.matchAll(/\]\((docs\/[^)#]+\.md)(?:#[^)]+)?\)/g)) {
  if (!existsSync(join(ROOT, match[1])))
    findings.push(`README.md links to missing ${match[1]}`);
}

if (findings.length) {
  for (const finding of findings) console.error(`Docs: ${finding}`);
  console.error(
    `Documentation check failed with ${findings.length} finding(s).`,
  );
  process.exitCode = 1;
} else {
  console.log(
    `Documentation check passed: ${required.length} required files, ${envNames.size} environment variables, and every workspace mapped.`,
  );
}
