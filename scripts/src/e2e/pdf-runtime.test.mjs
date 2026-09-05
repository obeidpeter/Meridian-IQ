import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DIST = path.join(ROOT, "artifacts/api-server/dist");

function syntheticPdf(text) {
  const stream = text
    ? `BT /F1 14 Tf 20 50 Td (${text}) Tj ET`
    : "1 0 0 rg 20 20 160 60 re f";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

test("built API retains the package-relative pdf-parse import", () => {
  const bundle = readFileSync(path.join(DIST, "index.mjs"), "utf8");
  assert.ok(
    /import\(["']pdf-parse["']\)/.test(bundle),
    "API must import the external pdf-parse package",
  );
  assert.ok(
    !bundle.includes("GlobalWorkerOptions.workerSrc"),
    "PDF.js worker resolution must remain inside its package",
  );
  assert.ok(
    !bundle.includes('canvas = require2("@napi-rs/canvas")'),
    "native canvas resolution must remain inside its package",
  );
});

test(
  "API dist resolves PDF text extraction, worker and native scan rasterization",
  { timeout: 60_000 },
  () => {
    // Eval's module URL is in the actual dist directory, matching the API's ESM
    // resolution boundary without importing its DB-connected startup entrypoint.
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    globalThis.fetch = () => { throw new Error('PDF smoke must not access the network'); };
    const { PDFParse } = await import('pdf-parse');
    const require = createRequire(import.meta.url);
    const packageRequire = createRequire(require.resolve('pdf-parse'));
    const { createCanvas, loadImage } = packageRequire('@napi-rs/canvas');
    const text = new PDFParse({ data: Buffer.from(${JSON.stringify(syntheticPdf("MERIDIAN PDF RUNTIME"))}, 'base64') });
    try {
      const result = await text.getText({ pageJoiner: '' });
      assert.equal(result.total, 1);
      assert.match(result.text, /MERIDIAN PDF RUNTIME/);
    } finally { await text.destroy(); }
    const scan = new PDFParse({ data: Buffer.from(${JSON.stringify(syntheticPdf())}, 'base64') });
    try {
      assert.equal((await scan.getText({ pageJoiner: '' })).text.trim(), '');
      const result = await scan.getScreenshot({ first: 4, desiredWidth: 320 });
      assert.equal(result.total, 1);
      assert.equal(result.pages.length, 1);
      assert.ok(result.pages[0].dataUrl.startsWith('data:image/png;base64,'));
      const png = Buffer.from(result.pages[0].dataUrl.split(',')[1], 'base64');
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      const image = await loadImage(png);
      assert.equal(image.width, 320);
      assert.equal(image.height, 160);
      const context = createCanvas(320, 160).getContext('2d');
      context.drawImage(image, 0, 0);
      assert.deepEqual(Array.from(context.getImageData(160, 80, 1, 1).data), [255, 0, 0, 255]);
      assert.deepEqual(Array.from(context.getImageData(5, 5, 1, 1).data), [255, 255, 255, 255]);
    } finally { await scan.destroy(); }
    console.log('PDF_RUNTIME_OK');
  `,
      ],
      { cwd: DIST, encoding: "utf8", timeout: 50_000, windowsHide: true },
    );
    assert.match(output, /PDF_RUNTIME_OK/);
  },
);
