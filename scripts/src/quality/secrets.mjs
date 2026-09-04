import { basename } from "node:path";
import {
  displayPath,
  isTextFile,
  readText,
  workspaceFiles,
} from "./shared.mjs";

const forbiddenNames =
  /^(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:p12|pfx|key))$/i;
const allowedNames = new Set([".env.example"]);
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
];

const findings = [];
for (const file of workspaceFiles(["."])) {
  const name = basename(file);
  const path = displayPath(file);
  if (!allowedNames.has(name) && forbiddenNames.test(name)) {
    findings.push(`${path}: sensitive filename is tracked`);
    continue;
  }
  if (
    !isTextFile(file) ||
    path === "pnpm-lock.yaml" ||
    path.endsWith("secrets.mjs")
  )
    continue;
  const source = readText(file);
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) findings.push(`${path}: possible ${label}`);
  }
}

if (findings.length) {
  for (const finding of findings) console.error(finding);
  console.error(
    `Secret scan failed with ${findings.length} high-confidence finding(s).`,
  );
  process.exitCode = 1;
} else {
  console.log(
    "Secret scan passed: no tracked secret files or high-confidence credentials found.",
  );
}
