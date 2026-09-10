import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import {
  displayPath,
  readText,
  SOURCE_EXTENSIONS,
  sourceFiles,
} from "./shared.mjs";

const files = sourceFiles();
const fileSet = new Set(files.map((file) => normalize(file)));
// SOURCE_EXTENSIONS is a Set; resolveRelativeImport needs array semantics
// (`.includes`/`.map`), so spread it in the same insertion order.
const extensions = [...SOURCE_EXTENSIONS];

function importSpecifiers(source) {
  const found = new Set();
  const staticPattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  const dynamicPattern = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const pattern of [staticPattern, dynamicPattern]) {
    for (const match of source.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

function resolveRelativeImport(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const raw = resolve(dirname(from), specifier);
  const hasSourceExtension = extensions.includes(extname(raw));
  const candidates = hasSourceExtension
    ? [
        raw,
        ...extensions.map((extension) => raw.replace(/\.[^.]+$/, extension)),
      ]
    : [
        ...extensions.map((extension) => `${raw}${extension}`),
        ...extensions.map((extension) => join(raw, `index${extension}`)),
      ];
  return (
    candidates
      .map(normalize)
      .find((candidate) => fileSet.has(candidate) && existsSync(candidate)) ??
    null
  );
}

const imports = new Map();
const violations = [];
for (const file of files) {
  const source = readText(file);
  const specs = importSpecifiers(source);
  imports.set(
    file,
    specs
      .map((specifier) => resolveRelativeImport(file, specifier))
      .filter(Boolean),
  );
  const name = displayPath(file);
  const production =
    !/\.(?:test|spec)\.[^.]+$/.test(name) &&
    !/\/test-support\.[^.]+$/.test(name);

  if (
    /^artifacts\/(?:landing|console|sme-compliance|buyer-portal|penalty-calculator|mobile)\//.test(
      name,
    )
  ) {
    for (const specifier of specs) {
      if (
        specifier === "@workspace/db" ||
        specifier.startsWith("@workspace/api-server")
      ) {
        violations.push(
          `${name}: browser/mobile code imports server-only package ${specifier}`,
        );
      }
    }
  }

  if (production && name.startsWith("artifacts/api-server/src/modules/")) {
    for (const target of imports.get(file)) {
      if (displayPath(target).startsWith("artifacts/api-server/src/routes/")) {
        violations.push(
          `${name}: domain module imports HTTP route ${displayPath(target)}`,
        );
      }
    }
  }

  for (const specifier of specs) {
    if (
      specifier.startsWith("@workspace/integrations-openai-ai-server") &&
      name !== "artifacts/api-server/src/modules/clerk/provider.ts"
    ) {
      violations.push(
        `${name}: model SDK access must go through modules/clerk/provider.ts`,
      );
    }
  }
}

let index = 0;
const stack = [];
const onStack = new Set();
const indexes = new Map();
const lowLinks = new Map();
const cycles = [];

function strongConnect(file) {
  indexes.set(file, index);
  lowLinks.set(file, index);
  index += 1;
  stack.push(file);
  onStack.add(file);

  for (const dependency of imports.get(file) ?? []) {
    if (!indexes.has(dependency)) {
      strongConnect(dependency);
      lowLinks.set(
        file,
        Math.min(lowLinks.get(file), lowLinks.get(dependency)),
      );
    } else if (onStack.has(dependency)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indexes.get(dependency)));
    }
  }

  if (lowLinks.get(file) !== indexes.get(file)) return;
  const component = [];
  let current;
  do {
    current = stack.pop();
    onStack.delete(current);
    component.push(current);
  } while (current !== file);
  if (component.length > 1 || (imports.get(file) ?? []).includes(file)) {
    cycles.push(component.map(displayPath).sort());
  }
}

for (const file of files) if (!indexes.has(file)) strongConnect(file);

console.log(
  `Architecture check: ${files.length} source files, ${[...imports.values()].reduce((sum, edges) => sum + edges.length, 0)} relative import edges.`,
);
for (const cycle of cycles) console.error(`Cycle: ${cycle.join(" -> ")}`);
for (const violation of violations) console.error(`Boundary: ${violation}`);

if (cycles.length || violations.length) {
  console.error(
    `Architecture check failed: ${cycles.length} cycle(s), ${violations.length} boundary violation(s).`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "Architecture check passed: no import cycles or boundary violations.",
  );
}
