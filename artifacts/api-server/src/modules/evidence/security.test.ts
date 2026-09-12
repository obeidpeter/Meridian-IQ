import assert from "node:assert/strict";
import { test } from "node:test";
import "./pdf-validation.test";
import { evidenceScannerAvailable, scanEvidenceBytes } from "./clamav";
import {
  decryptEvidence,
  encryptEvidence,
  evidenceHash,
  evidenceStorageAvailable,
  MAX_EVIDENCE_BYTES,
  validateEvidenceUpload,
} from "./security";
import {
  TEST_EVIDENCE_KEY,
  TEST_EVIDENCE_PDF,
  withEvidenceEnvironment,
  withMockClamAv,
} from "./security-test-fixtures";

const scope = "firm-a:request-a:file-a";
const upload = (bytes = TEST_EVIDENCE_PDF) => ({
  filename: "supporting-record.pdf",
  contentType: "application/pdf",
  contentBase64: bytes.toString("base64"),
});

test("encryption is randomized, authenticated and bound to every storage scope component", async () => {
  await withEvidenceEnvironment(
    { EVIDENCE_ENCRYPTION_KEY: TEST_EVIDENCE_KEY },
    () => {
      const first = encryptEvidence(TEST_EVIDENCE_PDF, scope);
      const second = encryptEvidence(TEST_EVIDENCE_PDF, scope);
      assert.notEqual(first, second);
      assert.equal(first.split(".").length, 3);
      assert.ok(!first.includes(TEST_EVIDENCE_PDF.toString()));
      assert.deepEqual(decryptEvidence(first, scope), TEST_EVIDENCE_PDF);
      for (const other of [
        "firm-b:request-a:file-a",
        "firm-a:request-b:file-a",
        "firm-a:request-a:file-b",
      ]) {
        assert.throws(() => decryptEvidence(first, other), {
          code: "EVIDENCE_INTEGRITY_FAILED",
          status: 503,
        });
      }
    },
  );
});

test("tampered nonce, tag and ciphertext fail without disclosing storage data", async () => {
  await withEvidenceEnvironment(
    { EVIDENCE_ENCRYPTION_KEY: TEST_EVIDENCE_KEY },
    () => {
      const encrypted = encryptEvidence(TEST_EVIDENCE_PDF, scope);
      for (let index = 0; index < 3; index++) {
        const parts = encrypted.split(".");
        const bytes = Buffer.from(parts[index], "base64url");
        bytes[0] ^= 1;
        parts[index] = bytes.toString("base64url");
        assert.throws(
          () => decryptEvidence(parts.join("."), scope),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.equal(
              error.message,
              "This document could not be read safely. Contact support.",
            );
            assert.ok(!error.message.includes(encrypted));
            return true;
          },
        );
      }
      for (const broken of [
        "",
        "one.two",
        "...",
        "a.b.c",
        `${encrypted}.extra`,
      ]) {
        assert.throws(() => decryptEvidence(broken, scope), {
          code: "EVIDENCE_INTEGRITY_FAILED",
        });
      }
    },
  );
});

test("an incorrect storage key cannot decrypt a valid envelope", async () => {
  const encrypted = await withEvidenceEnvironment(
    { EVIDENCE_ENCRYPTION_KEY: TEST_EVIDENCE_KEY },
    () => encryptEvidence(TEST_EVIDENCE_PDF, scope),
  );
  await withEvidenceEnvironment(
    { EVIDENCE_ENCRYPTION_KEY: Buffer.alloc(32, 0x43).toString("hex") },
    () => {
      assert.throws(() => decryptEvidence(encrypted, scope), {
        code: "EVIDENCE_INTEGRITY_FAILED",
      });
    },
  );
});

test("production requires a dedicated canonical 32-byte key and accepts hex or base64", async () => {
  for (const key of [
    undefined,
    "",
    "short",
    "a".repeat(63),
    "a".repeat(66),
    Buffer.alloc(31).toString("base64"),
    "!".repeat(44),
  ]) {
    await withEvidenceEnvironment(
      { NODE_ENV: "production", EVIDENCE_ENCRYPTION_KEY: key },
      () => {
        assert.equal(evidenceStorageAvailable(), false);
        assert.throws(() => encryptEvidence(TEST_EVIDENCE_PDF, scope), {
          code: "EVIDENCE_STORAGE_UNAVAILABLE",
          status: 503,
        });
      },
    );
  }
  for (const key of [
    TEST_EVIDENCE_KEY,
    Buffer.from(TEST_EVIDENCE_KEY, "hex").toString("base64"),
  ]) {
    await withEvidenceEnvironment(
      { NODE_ENV: "production", EVIDENCE_ENCRYPTION_KEY: key },
      () => {
        assert.equal(evidenceStorageAvailable(), true);
        assert.deepEqual(
          decryptEvidence(encryptEvidence(TEST_EVIDENCE_PDF, scope), scope),
          TEST_EVIDENCE_PDF,
        );
      },
    );
  }
});

test("an invalid explicit development key fails closed instead of using the local fallback", async () => {
  await withEvidenceEnvironment(
    { NODE_ENV: "test", EVIDENCE_ENCRYPTION_KEY: "invalid-explicit-test-key" },
    () => {
      assert.equal(evidenceStorageAvailable(), false);
      assert.throws(() => encryptEvidence(TEST_EVIDENCE_PDF, scope), {
        code: "EVIDENCE_STORAGE_UNAVAILABLE",
      });
    },
  );
});

test("upload validation accepts matching PDF, PNG and JPEG intake signatures", () => {
  assert.deepEqual(validateEvidenceUpload(upload()), TEST_EVIDENCE_PDF);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=",
    "base64",
  );
  const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
  for (const [filename, contentType, bytes] of [
    ["image.PNG", "image/png", png],
    ["image.JPEG", "image/jpeg", jpeg],
  ] as const) {
    assert.deepEqual(
      validateEvidenceUpload({
        filename,
        contentType,
        contentBase64: bytes.toString("base64"),
      }),
      bytes,
    );
  }
});

test("filenames reject traversal, separators, control characters and excessive length", () => {
  for (const filename of [
    "",
    "   ",
    "../record.pdf",
    "..\\record.pdf",
    "path/record.pdf",
    "record\0.pdf",
    "record\r\n.pdf",
    "record\u007f.pdf",
    `${"a".repeat(157)}.pdf`,
  ]) {
    assert.throws(() => validateEvidenceUpload({ ...upload(), filename }), {
      code: "EVIDENCE_FILENAME_INVALID",
      status: 400,
    });
  }
  assert.deepEqual(
    validateEvidenceUpload({ ...upload(), filename: `${"a".repeat(156)}.pdf` }),
    TEST_EVIDENCE_PDF,
  );
});

test("noncanonical or malformed base64 is not silently repaired", () => {
  const encoded = upload().contentBase64;
  for (const contentBase64 of [
    "",
    "Zg=",
    "Zh==",
    "Zg===",
    "=Zg=",
    "!!!!",
    `${encoded}\n`,
    `data:application/pdf;base64,${encoded}`,
    encoded.replace(/.$/, "_"),
  ]) {
    assert.throws(
      () => validateEvidenceUpload({ ...upload(), contentBase64 }),
      { code: "BAD_UPLOAD", status: 400 },
    );
  }
});

test("MIME, extension and complete signatures must agree and active PDFs are rejected", () => {
  for (const candidate of [
    { ...upload(), contentType: "text/html" },
    { ...upload(), filename: "record.png" },
    { ...upload(), filename: "record.pdf.exe" },
    upload(Buffer.from("<html><script>alert(1)</script></html>")),
    upload(Buffer.from("%PDF-1.7\ntruncated")),
    upload(
      Buffer.concat([
        TEST_EVIDENCE_PDF,
        Buffer.from("<script>after EOF</script>"),
      ]),
    ),
  ])
    assert.throws(() => validateEvidenceUpload(candidate), {
      code: "EVIDENCE_TYPE_INVALID",
    });
  for (const name of [
    "JavaScript",
    "JS",
    "Launch",
    "EmbeddedFile",
    "RichMedia",
    "AA",
  ]) {
    const bytes = Buffer.from(
      `%PDF-1.7\n<< /${name} (synthetic active-content test) >>\n%%EOF\n`,
    );
    assert.throws(() => validateEvidenceUpload(upload(bytes)), {
      code: "EVIDENCE_ACTIVE_CONTENT",
      status: 400,
    });
  }
});

test("the 5 MiB boundary is enforced on decoded and encoded bytes", () => {
  const bytes = Buffer.alloc(MAX_EVIDENCE_BYTES, 32);
  bytes.write("%PDF-1.7\n");
  bytes.write("\n%%EOF", bytes.length - 6);
  assert.equal(
    validateEvidenceUpload(upload(bytes)).length,
    MAX_EVIDENCE_BYTES,
  );
  const oneOver = Buffer.concat([
    bytes.subarray(0, -6),
    Buffer.from(" \n%%EOF"),
  ]);
  assert.equal(oneOver.length, MAX_EVIDENCE_BYTES + 1);
  assert.throws(() => validateEvidenceUpload(upload(oneOver)), {
    code: "UPLOAD_TOO_LARGE",
    status: 413,
  });
  assert.throws(
    () =>
      validateEvidenceUpload({
        ...upload(),
        contentBase64: "A".repeat(Math.ceil(MAX_EVIDENCE_BYTES / 3) * 4 + 4),
      }),
    { code: "UPLOAD_TOO_LARGE" },
  );
});

test("evidence digests are stable SHA-256 over the exact bytes", () => {
  assert.equal(
    evidenceHash(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.notEqual(
    evidenceHash(TEST_EVIDENCE_PDF),
    evidenceHash(Buffer.concat([TEST_EVIDENCE_PDF, Buffer.from("\n")])),
  );
});

test("an absent or invalid scanner never marks bytes clean", async () => {
  for (const port of [
    undefined,
    "",
    "0",
    "65536",
    "-1",
    "443/path",
    "https://remote.example",
    "12.5",
  ]) {
    await withEvidenceEnvironment({ EVIDENCE_CLAMAV_PORT: port }, async () => {
      assert.equal(evidenceScannerAvailable(), false);
      await assert.rejects(scanEvidenceBytes(TEST_EVIDENCE_PDF), {
        code: "EVIDENCE_SCAN_UNAVAILABLE",
        status: 503,
      });
    });
  }
});

test("ClamAV INSTREAM sends exact bytes only to the ephemeral loopback daemon", async () => {
  await withMockClamAv(
    () => "stream: OK\0",
    async (scans) => {
      assert.equal(await scanEvidenceBytes(TEST_EVIDENCE_PDF), "clean");
      assert.deepEqual(scans, [TEST_EVIDENCE_PDF]);
    },
  );
});

test("a synthetic FOUND reply is rejected, while unexpected or oversized replies fail closed", async () => {
  await withMockClamAv(
    () => "stream: SYNTHETIC-NOT-MALWARE FOUND\0",
    async () => {
      assert.equal(await scanEvidenceBytes(TEST_EVIDENCE_PDF), "rejected");
    },
  );
  for (const reply of [
    "stream: scanner ERROR\0",
    "OK\0",
    "stream: OK",
    `${"x".repeat(4097)}\0`,
  ]) {
    await withMockClamAv(
      () => reply,
      async () => {
        await assert.rejects(scanEvidenceBytes(TEST_EVIDENCE_PDF), {
          code: "EVIDENCE_SCAN_UNAVAILABLE",
        });
      },
    );
  }
});

test("a silent ClamAV daemon times out at the eight-second deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  try {
    await withMockClamAv(
      async () => {
        t.mock.timers.tick(7999);
        await Promise.resolve();
        assert.equal(settled, false);
        t.mock.timers.tick(1);
        return null;
      },
      async () => {
        const scan = scanEvidenceBytes(TEST_EVIDENCE_PDF).finally(() => {
          settled = true;
        });
        await assert.rejects(scan, {
          code: "EVIDENCE_SCAN_UNAVAILABLE",
          status: 503,
        });
        assert.equal(settled, true);
      },
    );
  } finally {
    t.mock.timers.reset();
  }
});

test("scan cancellation releases a pending connection and oversized files never reach the daemon", async () => {
  const controller = new AbortController();
  await withMockClamAv(
    () => {
      controller.abort(new Error("synthetic scan cancelled"));
      return null;
    },
    async (scans) => {
      await assert.rejects(
        scanEvidenceBytes(TEST_EVIDENCE_PDF, controller.signal),
        /synthetic scan cancelled/,
      );
      assert.equal(scans.length, 1);
      await assert.rejects(
        scanEvidenceBytes(Buffer.alloc(MAX_EVIDENCE_BYTES + 1)),
        { code: "EVIDENCE_SCAN_UNAVAILABLE" },
      );
      assert.equal(scans.length, 1);
    },
  );
});
