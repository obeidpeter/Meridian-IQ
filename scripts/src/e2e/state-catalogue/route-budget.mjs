import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gzipSync } from "node:zlib";
import ts from "typescript";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const require = createRequire(path.join(root, "lib/web-config/package.json"));
const vite = path.join(
  path.dirname(require.resolve("vite/package.json")),
  "bin/vite.js",
);
const out = path.join(root, "tmp/route-budget-r198");
const apps = [
  "console",
  "sme-compliance",
  "buyer-portal",
  "landing",
  "penalty-calculator",
];
const report = {
  generatedAt: new Date().toISOString(),
  apps: {},
  architecture: [],
};
await mkdir(out, { recursive: true });

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(file)));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|spec)\.tsx?$/.test(entry.name)
    )
      files.push(file);
  }
  return files;
}

for (const app of apps) {
  const directory = path.join(root, "artifacts", app);
  for (const file of await sourceFiles(path.join(directory, "src"))) {
    const source = await readFile(file, "utf8");
    assert(
      !source.includes("meridianiq:operations:"),
      `Unscoped operation key in ${file}; use operationSessionKey`,
    );
    assert(
      !source.includes("state-catalogue"),
      `Development catalogue imported by production: ${file}`,
    );
    if (path.basename(file) !== "App.tsx" && path.basename(file) !== "main.tsx")
      continue;
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    for (const statement of ast.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        assert(
          !/(?:^|\/)pages\//.test(statement.moduleSpecifier.text),
          `Eager page import in ${file}: ${statement.moduleSpecifier.text}`,
        );
      }
    }
  }
  report.architecture.push(
    `${app}: no eager page imports in route entries, raw operation keys, or production catalogue references`,
  );
  const destination = path.join(out, app);
  const result = spawnSync(
    process.execPath,
    [
      vite,
      "build",
      "--configLoader",
      "runner",
      "--manifest",
      "--outDir",
      destination,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "production" },
    },
  );
  await writeFile(
    path.join(out, `${app}.build.log`),
    result.stdout + result.stderr,
  );
  assert.equal(
    result.status,
    0,
    `${app} build failed; see ${out}/${app}.build.log`,
  );
  const manifest = JSON.parse(
    await readFile(path.join(destination, ".vite/manifest.json"), "utf8"),
  );
  const closure = new Set();
  function visit(key) {
    if (closure.has(key)) return;
    closure.add(key);
    for (const imported of manifest[key].imports ?? []) visit(imported);
  }
  Object.entries(manifest)
    .filter(([, chunk]) => chunk.isEntry)
    .forEach(([key]) => visit(key));
  const chunks = await Promise.all(
    [...closure].map(async (key) => {
      const bytes = await readFile(path.join(destination, manifest[key].file));
      return {
        source: key,
        file: manifest[key].file,
        bytes: bytes.length,
        gzipBytes: gzipSync(bytes).length,
      };
    }),
  );
  const dynamicEntries = Object.entries(manifest)
    .filter(([, chunk]) => chunk.isDynamicEntry)
    .map(([key, chunk]) => ({ source: key, file: chunk.file }));
  report.apps[app] = {
    eagerBytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
    eagerGzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    dynamicEntries: dynamicEntries.length,
    chunks,
    lazy: dynamicEntries,
  };
  console.log(
    `${app}: ${report.apps[app].eagerGzipBytes} eager gzip bytes; ${dynamicEntries.length} lazy entries`,
  );
}
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
if (!process.argv.includes("--measure-only")) {
  const budgets = JSON.parse(
    await readFile(path.join(here, "route-budgets.json"), "utf8"),
  );
  for (const app of apps) {
    assert(
      report.apps[app].eagerGzipBytes <= budgets[app].maxEagerGzipBytes,
      `${app} exceeds its eager gzip budget`,
    );
    assert(
      report.apps[app].dynamicEntries >= budgets[app].minDynamicEntries,
      `${app} lost lazy route entries`,
    );
  }
  console.log("Route architecture and measured bundle budgets passed.");
}
