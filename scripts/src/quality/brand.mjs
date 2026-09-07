import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayPath, ROOT, sourceFiles } from "./shared.mjs";

// Historical identifiers (cookies, DB policies, provider IDs and real URLs)
// are compatibility contracts. This gate targets product-facing brand copy.
const findings = [];
for (const file of sourceFiles()) {
  const relative = displayPath(file);
  if (!/^(artifacts|lib)\//.test(relative) || /(?:\.test\.|\/test\/|\/migrations\/)/.test(relative)) continue;
  const source = readFileSync(file, "utf8");
  if (/\bMeridianIQ\b(?![.:/_-])|\bMeridian Today\b/.test(source))
    findings.push(`Previous product name in ${relative}`);
}

for (const app of ["landing", "console", "sme-compliance", "buyer-portal", "penalty-calculator"]) {
  const html = readFileSync(join(ROOT, "artifacts", app, "index.html"), "utf8");
  if (!/<title>[^<]*Valo[^<]*<\/title>/.test(html)) findings.push(`${app} needs a Valo page title`);
  const favicon = readFileSync(join(ROOT, "artifacts", app, "public/favicon.svg"), "utf8");
  if (!favicon.includes('d="M7 8 16 24 25 8"')) findings.push(`${app} needs the shared V favicon`);
}
const manifest = JSON.parse(readFileSync(join(ROOT, "artifacts/sme-compliance/public/manifest.webmanifest"), "utf8"));
if (manifest.short_name !== "Valo" || !manifest.name.startsWith("Valo")) findings.push("PWA manifest must use Valo");
const mobile = JSON.parse(readFileSync(join(ROOT, "artifacts/mobile/app.json"), "utf8")).expo;
if (!mobile.name.startsWith("Valo")) findings.push("Mobile app must use Valo");

if (findings.length) {
  findings.forEach((finding) => console.error(`Brand: ${finding}`));
  process.exitCode = 1;
} else {
  console.log("Valo brand check passed: active product copy, five web titles/favicons, PWA and mobile metadata.");
}
