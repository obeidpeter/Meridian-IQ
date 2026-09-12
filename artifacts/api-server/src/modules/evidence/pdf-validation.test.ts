import assert from "node:assert/strict";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import {
  assertEvidencePdfSafe,
  MAX_VALIDATION_PDF_PAGES,
} from "./pdf-validation";
import { makeEvidencePdf } from "./pdf-test-fixtures";
import { validateEvidenceUpload } from "./security";

const inertAction = "<< /S /Java#53cript /J#53 (synthetic-review-fixture) >>";
const activeError = { code: "EVIDENCE_ACTIVE_CONTENT", status: 400 };

function generatedPdf(pages = 1, password?: string): Promise<Buffer> {
  const doc = new PDFDocument({ userPassword: password });
  const chunks: Buffer[] = [];
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (bytes: Buffer) => chunks.push(bytes));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  doc.text("Supporting invoice INV-2026-001. Amount paid: NGN 1,250.00");
  doc.text("Public website", { link: "https://example.invalid/" });
  doc.rect(30, 120, 100, 40).stroke();
  for (let page = 1; page < pages; page++)
    doc.addPage().text("Additional record");
  doc.end();
  return result;
}

test("structural PDF inspection accepts ordinary documents, navigation, static forms and object streams", async () => {
  for (const bytes of [
    await generatedPdf(),
    makeEvidencePdf(),
    makeEvidencePdf({ compressed: true }),
    makeEvidencePdf({ catalog: "/OpenAction [3 0 R /Fit]" }),
    makeEvidencePdf({
      compressed: true,
      catalog: "/AcroForm << /Fields [4 0 R] >>",
      page: "/Annots [4 0 R]",
      objects: [
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (reference) /V (INV-001) /Rect [10 10 90 30] /P 3 0 R >>",
      ],
    }),
  ])
    await assertEvidencePdfSafe(bytes);
});

test("structural PDF inspection resolves escaped and compressed document actions without executing them", async () => {
  for (const compressed of [false, true]) {
    for (const catalog of [
      "/Open#41ction 4 0 R",
      "/AA << /WC 4 0 R >>",
      "/Names << /Java#53cript << /Names [(script) 4 0 R] >> >>",
    ]) {
      const bytes = makeEvidencePdf({
        compressed,
        catalog,
        objects: [inertAction],
      });
      if (compressed) {
        // The synchronous byte filter cannot see objects inside Flate streams.
        assert.equal(
          validateEvidenceUpload({
            filename: "record.pdf",
            contentType: "application/pdf",
            contentBase64: bytes.toString("base64"),
          }).length,
          bytes.length,
        );
      }
      await assert.rejects(assertEvidencePdfSafe(bytes), activeError);
    }
  }
});

test("structural PDF inspection rejects page and form actions including hidden widgets", async () => {
  await assert.rejects(
    assertEvidencePdfSafe(
      makeEvidencePdf({
        compressed: true,
        page: "/AA << /O 4 0 R >>",
        objects: [inertAction],
      }),
    ),
    activeError,
  );
  await assert.rejects(
    assertEvidencePdfSafe(
      makeEvidencePdf({
        compressed: true,
        catalog: "/AcroForm << /Fields [4 0 R] >>",
        page: "/Annots [4 0 R]",
        objects: [
          "<< /Type /Annot /Subtype /Widget /FT /Tx /T (reference) /Rect [10 10 90 30] /F 2 /P 3 0 R /AA << /K 5 0 R >> >>",
          inertAction,
        ],
      }),
    ),
    activeError,
  );
});

test("structural PDF inspection rejects attachments, rich media and XFA", async () => {
  for (const subtype of [
    "FileAttachment",
    "RichMedia",
    "Movie",
    "Sound",
    "Screen",
    "3D",
  ]) {
    await assert.rejects(
      assertEvidencePdfSafe(
        makeEvidencePdf({
          compressed: true,
          page: "/Annots [4 0 R]",
          objects: [
            `<< /Type /Annot /Subtype /${subtype} /Rect [10 10 90 30] /FS << /Type /Filespec /F (fixture.txt) >> >>`,
          ],
        }),
      ),
      activeError,
    );
  }
  await assert.rejects(
    assertEvidencePdfSafe(
      makeEvidencePdf({
        catalog:
          "/Names << /EmbeddedFiles << /Names [(attachment) 4 0 R] >> >>",
        objects: [
          "<< /Type /Filespec /F (fixture.txt) /EF << /F 5 0 R >> >>",
          "<< /Type /EmbeddedFile /Length 7 >>\nstream\nfixture\nendstream",
        ],
      }),
    ),
    activeError,
  );
  await assert.rejects(
    assertEvidencePdfSafe(
      makeEvidencePdf({
        catalog: "/AcroForm << /Fields [] /XFA 4 0 R >>",
        objects: ["<< /Length 8 >>\nstream\n<xfa />\nendstream"],
      }),
    ),
    activeError,
  );
});

test("PDF inspection rejects unreadable, password-protected, oversized and excessive-page inputs", async () => {
  for (const bytes of [
    Buffer.from("%PDF-1.7\n%%EOF\n"),
    await generatedPdf(1, "synthetic-password"),
  ]) {
    await assert.rejects(assertEvidencePdfSafe(bytes), {
      code: "EVIDENCE_PDF_UNREADABLE",
      status: 422,
    });
  }
  await assert.rejects(
    assertEvidencePdfSafe(Buffer.alloc(5 * 1024 * 1024 + 1)),
    { code: "EVIDENCE_PDF_LIMIT" },
  );
  await assert.rejects(
    assertEvidencePdfSafe(await generatedPdf(MAX_VALIDATION_PDF_PAGES + 1)),
    { code: "EVIDENCE_PDF_LIMIT" },
  );
});

test("PDF inspection kills a child at its deadline and releases capacity for subsequent inspection", async () => {
  const bytes = makeEvidencePdf();
  await assert.rejects(assertEvidencePdfSafe(bytes, 1), {
    code: "EVIDENCE_PDF_TIMEOUT",
  });
  await assertEvidencePdfSafe(bytes);
});

test("PDF inspection refuses work beyond two isolated children without queueing document bytes", async () => {
  const bytes = makeEvidencePdf();
  const first = assertEvidencePdfSafe(bytes, 1);
  const second = assertEvidencePdfSafe(bytes, 1);
  const results = Promise.allSettled([first, second]);
  await assert.rejects(assertEvidencePdfSafe(bytes), {
    code: "EVIDENCE_PDF_BUSY",
    status: 503,
  });
  assert.ok((await results).every((result) => result.status === "rejected"));
  await assertEvidencePdfSafe(bytes);
});

test("the synchronous PDF byte filter also rejects escaped active names", () => {
  for (const name of [
    "Java#53cript",
    "J#53",
    "La#75nch",
    "Embedded#46ile",
    "Rich#4dedia",
  ]) {
    const bytes = makeEvidencePdf({ catalog: `/${name} (synthetic-fixture)` });
    assert.throws(
      () =>
        validateEvidenceUpload({
          filename: "record.pdf",
          contentType: "application/pdf",
          contentBase64: bytes.toString("base64"),
        }),
      activeError,
    );
  }
});
