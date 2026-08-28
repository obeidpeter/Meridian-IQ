import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The architecture guidebook (docs/architecture.md) claims to name every
// workspace package, to carry the C4 maps and the decision log, and that the
// model-provider client has exactly one importer. Architecture claims rot
// silently — these tripwires make the map match the territory: adding a
// package, making a significant decision, or widening the provider surface
// must move the doc (or fail loudly) in the same change.

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOC = readFileSync(join(ROOT, "docs", "architecture.md"), "utf8");

// Mirror pnpm-workspace.yaml's package globs: artifacts/*, lib/*, scripts.
function workspacePackageNames(): string[] {
  const names: string[] = [];
  for (const parent of ["artifacts", "lib"]) {
    for (const entry of readdirSync(join(ROOT, parent))) {
      const pkg = join(ROOT, parent, entry, "package.json");
      if (existsSync(pkg)) {
        names.push(JSON.parse(readFileSync(pkg, "utf8")).name as string);
      }
    }
  }
  names.push(
    JSON.parse(readFileSync(join(ROOT, "scripts", "package.json"), "utf8"))
      .name as string,
  );
  return names;
}

test("every workspace package is named in the architecture guidebook", () => {
  const names = workspacePackageNames();
  assert.ok(
    names.length >= 17,
    `workspace enumeration looks sane (${names.length})`,
  );
  for (const name of names) {
    assert.ok(DOC.includes(name), `docs/architecture.md must mention ${name}`);
  }
});

test("the guidebook carries both C4 maps and the decision log", () => {
  const fences = DOC.match(/```mermaid/g) ?? [];
  assert.ok(
    fences.length >= 2,
    "context + container diagrams (two mermaid fences) must exist",
  );
  const decisions = DOC.match(/^### D\d+ — /gm) ?? [];
  assert.ok(
    decisions.length >= 10,
    `at least ten decision-log entries (found ${decisions.length})`,
  );
  // Honesty pin: the rails stay labelled simulated until accreditation.
  // Removing the word is an activation decision, not a doc tweak.
  assert.ok(
    DOC.includes("simulated"),
    "the rails are labelled simulated until accredited",
  );
});

test("the provider client is imported only by the Clerk provider layer (D8)", () => {
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (
        /\.m?ts$/.test(entry.name) &&
        readFileSync(p, "utf8").includes("integrations-openai-ai-server")
      ) {
        offenders.push(p);
      }
    }
  };
  walk(import.meta.dirname);
  const stray = offenders.filter(
    (p) =>
      p !== join(import.meta.dirname, "modules", "clerk", "provider.ts") &&
      !p.endsWith("architecture-conformance.test.ts"),
  );
  assert.deepEqual(
    stray,
    [],
    "only modules/clerk/provider.ts may import the provider client",
  );
});

test("shared usability surfaces do not drift back into app-local copies", () => {
  const localShortcutDialogs = [
    join(
      ROOT,
      "artifacts",
      "console",
      "src",
      "components",
      "shortcuts-dialog.tsx",
    ),
    join(
      ROOT,
      "artifacts",
      "sme-compliance",
      "src",
      "components",
      "shortcuts-dialog.tsx",
    ),
  ];
  assert.deepEqual(
    localShortcutDialogs.filter(existsSync),
    [],
    "keyboard shortcut help belongs in @workspace/web-ui",
  );

  for (const app of ["console", "sme-compliance"]) {
    const appSource = readFileSync(
      join(ROOT, "artifacts", app, "src", "App.tsx"),
      "utf8",
    );
    const layoutSource = readFileSync(
      join(ROOT, "artifacts", app, "src", "components", "layout.tsx"),
      "utf8",
    );
    const helpSource = readFileSync(
      join(ROOT, "artifacts", app, "src", "pages", "help.tsx"),
      "utf8",
    );

    assert.match(appSource, /path="\/activity"/, `${app} must route activity`);
    assert.match(
      layoutSource,
      /ShortcutsDialog/,
      `${app} must use shared shortcuts`,
    );
    assert.match(
      layoutSource,
      /href: "\/activity"/,
      `${app} must expose activity`,
    );
    assert.match(
      helpSource,
      /HelpSearchInput/,
      `${app} help must remain searchable`,
    );
    assert.match(
      helpSource,
      /HelpFeedback/,
      `${app} help must retain feedback`,
    );
  }
});
