import { ESLint } from "eslint";
import { displayPath, ROOT } from "./shared.mjs";

const eslint = new ESLint({
  cwd: ROOT,
  overrideConfig: {
    rules: { complexity: ["warn", 10] },
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
    const match = message.message.match(/complexity of (\d+)/);
    findings.push({
      file: displayPath(result.filePath),
      line: message.line,
      complexity: Number(match?.[1] ?? 0),
      message: message.message,
    });
  }
}
findings.sort((a, b) => b.complexity - a.complexity);
const report = {
  functionsOver10: findings.length,
  functionsOver20: findings.filter((finding) => finding.complexity > 20).length,
  maximum: findings[0]?.complexity ?? 0,
  highest: findings.slice(0, 20),
};

if (process.argv.includes("--json"))
  console.log(JSON.stringify(report, null, 2));
else {
  console.log(
    `Complexity report: ${report.functionsOver10} functions >10; ${report.functionsOver20} >20; maximum ${report.maximum}.`,
  );
  for (const finding of report.highest) {
    console.log(
      `${String(finding.complexity).padStart(3)}  ${finding.file}:${finding.line}`,
    );
  }
}
