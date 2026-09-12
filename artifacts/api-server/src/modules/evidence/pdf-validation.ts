import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DomainError } from "../errors";

export const MAX_VALIDATION_PDF_PAGES = 100;
export const PDF_VALIDATION_TIMEOUT_MS = 10_000;
const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_PDF_STRUCTURES = 5_000;
let activeInspections = 0;

// These public PDF.js APIs resolve escaped names, indirect objects and object
// streams. No rendering, scripting sandbox, action execution or URL loading is
// used. PDF.js is not a sanitizer: the malware scan remains a separate gate.
const INSPECT_PDF = `
process.once("message", async (input) => {
  let loading;
  let result = "EVIDENCE_PDF_UNREADABLE";
  const active = () => { throw new Error("EVIDENCE_ACTIVE_CONTENT"); };
  const nonempty = (value) => value && Object.keys(value).length > 0;
  const navigation = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage", "GoBack", "GoForward"]);
  const inspectLink = (item) => {
    if (nonempty(item.actions) || item.attachment || item.file || item.resetForm) active();
    if (item.action && !navigation.has(item.action)) active();
    const url = item.unsafeUrl || item.url;
    if (url && !/^(https?:|mailto:)/i.test(url)) active();
  };
  let count = 0;
  const countStructure = () => {
    if (++count > input.maxStructures) throw new Error("EVIDENCE_PDF_LIMIT");
  };
  try {
    const { createRequire } = require("node:module");
    const { pathToFileURL } = require("node:url");
    // pdf-parse supplies the installed PDF.js runtime's native DOM primitives.
    require(input.modulePath);
    const requirePdf = createRequire(input.modulePath);
    const { getDocument } = await import(pathToFileURL(requirePdf.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
    loading = getDocument({
      data: input.bytes, isEvalSupported: false, enableXfa: false,
      useSystemFonts: false, disableFontFace: true, useWorkerFetch: false,
      isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
      stopAtErrors: true, verbosity: 0,
    });
    const doc = await loading.promise;
    if (!Number.isInteger(doc.numPages) || doc.numPages < 1 || doc.numPages > input.maxPages)
      throw new Error("EVIDENCE_PDF_LIMIT");
    const { info } = await doc.getMetadata();
    if (info.EncryptFilterName) throw new Error("EVIDENCE_PDF_UNREADABLE");
    if (info.IsXFAPresent || doc.isPureXfa) active();
    if (nonempty(await doc.getJSActions()) || await doc.hasJSActions()) active();
    if (nonempty(await doc.getAttachments())) active();
    const open = await doc.getOpenAction();
    if (open?.action && !navigation.has(open.action)) active();
    const fields = await doc.getFieldObjects();
    for (const group of Object.values(fields || {})) {
      for (const field of group) {
        countStructure();
        inspectLink(field);
      }
    }
    const outline = [...(await doc.getOutline() || [])];
    while (outline.length) {
      countStructure();
      const item = outline.pop();
      inspectLink(item);
      outline.push(...(item.items || []));
    }
    const forbiddenAnnotations = new Set(["FileAttachment", "RichMedia", "Movie", "Sound", "Screen", "3D"]);
    for (let number = 1; number <= doc.numPages; number++) {
      const page = await doc.getPage(number);
      if (nonempty(await page.getJSActions())) active();
      // "any" includes hidden/nonprinting annotations, not only visible ones.
      for (const annotation of await page.getAnnotations({ intent: "any" })) {
        countStructure();
        if (forbiddenAnnotations.has(annotation.subtype)) active();
        inspectLink(annotation);
      }
      page.cleanup();
    }
    result = "ok";
  } catch (error) {
    if (["EVIDENCE_ACTIVE_CONTENT", "EVIDENCE_PDF_LIMIT"].includes(error?.message)) result = error.message;
  } finally {
    if (loading) await loading.destroy().catch(() => {});
    process.send(result, () => process.exit(0));
  }
});
`;

function inspectionError(code: string): DomainError {
  if (code === "EVIDENCE_ACTIVE_CONTENT")
    return new DomainError(
      code,
      "Use a flattened PDF without scripts, active actions or embedded attachments.",
      400,
    );
  return new DomainError(
    code,
    "This PDF could not be inspected within its safety limits. Use an unencrypted, flattened PDF of at most 100 pages.",
    422,
  );
}

export async function assertEvidencePdfSafe(
  bytes: Buffer,
  timeoutMs = PDF_VALIDATION_TIMEOUT_MS,
): Promise<void> {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES)
    throw inspectionError("EVIDENCE_PDF_LIMIT");
  if (activeInspections >= 2)
    throw new DomainError(
      "EVIDENCE_PDF_BUSY",
      "Document inspection is busy. Try the upload again shortly.",
      503,
    );
  activeInspections++;
  try {
    const modulePath = createRequire(import.meta.url).resolve("pdf-parse");
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=128", "--input-type=commonjs", "-e", INSPECT_PDF],
      {
        windowsHide: true,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      let result: string | null = null;
      let failure: string | null = null;
      const deadline = Number.isFinite(timeoutMs)
        ? Math.max(1, Math.min(timeoutMs, PDF_VALIDATION_TIMEOUT_MS))
        : PDF_VALIDATION_TIMEOUT_MS;
      const timer = setTimeout(() => {
        failure = "EVIDENCE_PDF_TIMEOUT";
        child.kill("SIGKILL");
      }, deadline);
      child.once("message", (message) => {
        if (
          typeof message === "string" &&
          [
            "ok",
            "EVIDENCE_ACTIVE_CONTENT",
            "EVIDENCE_PDF_LIMIT",
            "EVIDENCE_PDF_UNREADABLE",
          ].includes(message)
        )
          result = message;
        else failure = "EVIDENCE_PDF_UNREADABLE";
      });
      child.once("error", () => {
        failure ??= "EVIDENCE_PDF_UNREADABLE";
        child.kill("SIGKILL");
      });
      // Release the concurrency slot only after the process is actually gone.
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) failure ??= "EVIDENCE_PDF_UNREADABLE";
        if (!failure && result === "ok") resolve();
        else
          reject(
            inspectionError(failure ?? result ?? "EVIDENCE_PDF_UNREADABLE"),
          );
      });
      child.send(
        {
          modulePath,
          bytes: Uint8Array.from(bytes),
          maxPages: MAX_VALIDATION_PDF_PAGES,
          maxStructures: MAX_PDF_STRUCTURES,
        },
        (error) => {
          if (error) {
            failure ??= "EVIDENCE_PDF_UNREADABLE";
            child.kill("SIGKILL");
          }
        },
      );
    });
  } finally {
    activeInspections--;
  }
}
