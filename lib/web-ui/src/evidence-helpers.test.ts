// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import {
  EVIDENCE_MAX_BYTES,
  checkedEvidenceBlob,
  evidenceError,
  evidenceFilename,
  evidenceMagic,
  evidencePermissions,
  evidenceUploadContent,
} from "./evidence-helpers";
import { evidenceFixtureDetail, evidenceFixtureMe } from "./evidence-fixtures";

describe("Evidence error copy", () => {
  const known = [
    [
      "EVIDENCE_STORAGE_FULL",
      409,
      "This workspace has reached its document storage limit. Contact support.",
      /storage limit.*Contact support/,
    ],
    [
      "EVIDENCE_VERSION_LIMIT",
      409,
      "This request has reached its 20-version limit. Ask your accountant to create a new request.",
      /version limit.*create a new request/,
    ],
    [
      "EVIDENCE_REQUEST_LIMIT",
      409,
      "This workspace has reached its evidence-request limit. Contact support.",
      /request limit.*Contact support/,
    ],
    [
      "EVIDENCE_CLOSED",
      409,
      "This request has been cancelled. Create a new request if needed.",
      /closed.*accepted request.*new request.*cancelled/,
    ],
    [
      "EVIDENCE_VERSION_CONFLICT",
      409,
      "Someone changed this request. Refresh it before continuing.",
      /Someone changed.*Refresh/,
    ],
    [
      "EVIDENCE_REQUEST_REUSED",
      409,
      "This action was already used for different content. Refresh and try again.",
      /different content.*new attempt/,
    ],
    [
      "EVIDENCE_FILE_CHANGED",
      409,
      "Review the latest document before continuing.",
      /latest version.*review the latest document/,
    ],
    [
      "EVIDENCE_QUARANTINED",
      409,
      "This document has not passed its security scan and cannot be opened.",
      /not passed.*Wait for a clean result/,
    ],
    [
      "EVIDENCE_FILE_NOT_CLEAN",
      409,
      "Only clean evidence files can be read",
      /not passed.*before running assistance/,
    ],
    [
      "EVIDENCE_ALREADY_SCANNED",
      409,
      "This document has already passed its security scan.",
      /already passed.*Refresh/,
    ],
    [
      "EVIDENCE_SCAN_IN_PROGRESS",
      409,
      "This document is already waiting for a security scan.",
      /queued.*Wait a moment/,
    ],
    [
      "EVIDENCE_SCAN_UNAVAILABLE",
      503,
      "The security scanner is not configured. Contact your administrator.",
      /scanner is unavailable.*remains quarantined/,
    ],
    [
      "EVIDENCE_STORAGE_UNAVAILABLE",
      503,
      "Secure document storage is not configured. Contact your administrator.",
      /storage is unavailable.*administrator/,
    ],
    [
      "EVIDENCE_INTEGRITY_FAILED",
      503,
      "This document could not be read safely. Contact support.",
      /not be read safely.*Contact support/,
    ],
    [
      "EVIDENCE_INTEGRITY",
      409,
      "Evidence file integrity check failed",
      /not be read safely.*Contact support/,
    ],
    [
      "EVIDENCE_CHANGED",
      409,
      "Evidence request changed; run the checks again",
      /evidence changed.*run the checks again/,
    ],
    [
      "EVIDENCE_PACK_CHANGED",
      409,
      "Accept a clean evidence file before exporting a pack",
      /pack is not ready.*clean document is accepted/,
    ],
    [
      "EVIDENCE_PACK_TOO_LARGE",
      413,
      "Evidence packs must be under 25 MB with at most 50 files and 2000 history events",
      /export limit.*individually/,
    ],
    [
      "EVIDENCE_WORK_CONFLICT",
      409,
      "Document request conflicts with an existing work item",
      /existing work item.*contact support/,
    ],
    [
      "EVIDENCE_OWNER_INVALID",
      400,
      "Choose an owner who can access this client.",
      /workspace owner with access/,
    ],
    [
      "EVIDENCE_COMMENT_REQUIRED",
      400,
      "Explain what needs to change or why this request is being cancelled.",
      /explanation.*cancellation/,
    ],
    [
      "EVIDENCE_ACTIVE_CONTENT",
      400,
      "Use a flattened PDF without scripts or embedded attachments.",
      /unencrypted, flattened PDF.*100 pages without scripts/,
    ],
    [
      "EVIDENCE_PDF_BUSY",
      503,
      "Document inspection is busy. Try the upload again shortly.",
      /inspection is busy.*retry the same upload/,
    ],
    [
      "EVIDENCE_PDF_LIMIT",
      422,
      "This PDF could not be inspected within its safety limits. Use an unencrypted, flattened PDF of at most 100 pages.",
      /unencrypted, flattened PDF of at most 100 pages/,
    ],
    [
      "EVIDENCE_PDF_TIMEOUT",
      422,
      "This PDF could not be inspected within its safety limits. Use an unencrypted, flattened PDF of at most 100 pages.",
      /unencrypted, flattened PDF of at most 100 pages/,
    ],
    [
      "EVIDENCE_PDF_UNREADABLE",
      422,
      "This PDF could not be inspected within its safety limits. Use an unencrypted, flattened PDF of at most 100 pages.",
      /unencrypted, flattened PDF of at most 100 pages/,
    ],
    [
      "EVIDENCE_FILENAME_INVALID",
      400,
      "Use a filename without slashes or control characters.",
      /Rename.*select it again/,
    ],
    [
      "EVIDENCE_TYPE_INVALID",
      400,
      "Choose a valid PDF, PNG or JPEG with a matching filename.",
      /valid JPEG, PNG or PDF/,
    ],
  ] as const;

  test.each(known)(
    "maps %s from ApiError.data, including the current message-only body",
    (code, status, legacy, expected) => {
      const error = Object.assign(new Error("private transport details"), {
        name: "ApiError",
        status,
        data: { code, error: "private server details" },
      });
      const message = evidenceError(error);
      expect(message).toMatch(expected);
      expect(message).not.toContain("private");
      expect(evidenceError({ status, data: { error: legacy } })).toBe(message);
    },
  );

  test("recognizes the structural validator's active-content message", () => {
    expect(
      evidenceError({
        status: 400,
        data: {
          error:
            "Use a flattened PDF without scripts, active actions or embedded attachments.",
        },
      }),
    ).toBe(
      evidenceError({ status: 400, data: { code: "EVIDENCE_ACTIVE_CONTENT" } }),
    );
  });

  test.each([
    "This request is closed. Request changes before changing its assignment.",
    "This request is closed. Ask your accountant to request changes before uploading again.",
  ])("handles closed-request message variant: %s", (error) => {
    expect(evidenceError({ status: 409, data: { error } })).toBe(
      evidenceError({ status: 409, data: { code: "EVIDENCE_CLOSED" } }),
    );
  });

  test.each([
    undefined,
    null,
    "private server details",
    [],
    { code: "UNKNOWN", error: "private server details" },
    { code: "__proto__" },
    { code: "constructor" },
    { code: { toString: () => "EVIDENCE_CLOSED" } },
    { error: { code: "EVIDENCE_CLOSED" } },
    {
      message:
        "This request has been cancelled. Create a new request if needed.",
    },
    {
      code: "UNKNOWN",
      error: "This request has been cancelled. Create a new request if needed.",
    },
    {
      error:
        "This workspace has reached its document storage limit. Contact support. private server details",
    },
  ])("unknown or malformed payload %j keeps safe conflict fallback", (data) => {
    expect(evidenceError({ status: 409, data })).toBe(
      evidenceError({ status: 409 }),
    );
  });

  test("known codes cannot override mismatched status or authentication errors", () => {
    for (const status of [400, 401, 403, 404, 500]) {
      expect(evidenceError({ status, data: { code: "EVIDENCE_CLOSED" } })).toBe(
        evidenceError({ status }),
      );
    }
    expect(
      evidenceError({
        status: 401,
        data: {
          error:
            "This request has been cancelled. Create a new request if needed.",
        },
      }),
    ).toMatch(/Sign in again/);
    expect(evidenceError({ status: 413 })).toMatch(/5 MB/);
  });

  test("does not display arbitrary Error messages or non-ApiError code fields", () => {
    const fallback = evidenceError(undefined);
    expect(evidenceError(new Error("private document contents"))).toBe(
      fallback,
    );
    expect(evidenceError("private document contents")).toBe(fallback);
    expect(evidenceError({ code: "EVIDENCE_CLOSED" })).toBe(fallback);
    expect(evidenceError({ status: 409, code: "EVIDENCE_CLOSED" })).toBe(
      evidenceError({ status: 409 }),
    );
  });
});

describe("Evidence file boundary", () => {
  test("accepts PDF bytes and rejects spoofed, empty, oversized and long-named files", async () => {
    await expect(
      evidenceUploadContent(
        new File(["%PDF-test"], "note.pdf", { type: "application/pdf" }),
      ),
    ).resolves.toEqual({
      filename: "note.pdf",
      contentType: "application/pdf",
      contentBase64: btoa("%PDF-test"),
    });
    for (const file of [
      new File(["<html>"], "note.pdf", { type: "application/pdf" }),
      new File([], "empty.pdf", { type: "application/pdf" }),
      new File([new Uint8Array(EVIDENCE_MAX_BYTES + 1)], "large.pdf", {
        type: "application/pdf",
      }),
      new File(["%PDF-"], "x".repeat(161), { type: "application/pdf" }),
      new File(["<svg/>"], "image.svg", { type: "image/svg+xml" }),
    ])
      await expect(evidenceUploadContent(file)).rejects.toThrow();
  });
  test("recognises only JPEG, PNG and PDF signatures", () => {
    expect(evidenceMagic(new Uint8Array([255, 216, 255]))).toBe("image/jpeg");
    expect(
      evidenceMagic(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
    ).toBe("image/png");
    expect(evidenceMagic(new Uint8Array([80, 75]))).toBeNull();
  });
  test("downloads require clean state, matching size and matching bytes", async () => {
    const file = { ...evidenceFixtureDetail.files[0], byteSize: 8 };
    const pdf = new Blob(["%PDF-123"], { type: "text/html" });
    await expect(checkedEvidenceBlob(pdf, file)).resolves.toHaveProperty(
      "type",
      "application/pdf",
    );
    await expect(
      checkedEvidenceBlob(pdf, { ...file, scanStatus: "quarantined" }),
    ).rejects.toThrow();
    await expect(
      checkedEvidenceBlob(pdf, { ...file, byteSize: 2 }),
    ).rejects.toThrow();
    await expect(
      checkedEvidenceBlob(new Blob(["<script>"]), file),
    ).rejects.toThrow();
    expect(evidenceFilename("../../evil.html", "application/pdf")).toBe(
      "evil.pdf",
    );
  });
});
test("capabilities and feature gate control all roles; clients never request or review", () => {
  expect(evidencePermissions(evidenceFixtureMe)).toEqual({
    read: true,
    request: true,
    review: true,
    upload: true,
  });
  for (const role of [
    "client_user",
    "client_admin",
    "client_staff",
    "auditor",
    "operator",
    "bank_user",
  ])
    expect(evidencePermissions({ ...evidenceFixtureMe, role }).review).toBe(
      false,
    );
  expect(
    evidencePermissions({ ...evidenceFixtureMe, role: "client_user" }).request,
  ).toBe(false);
  expect(evidencePermissions({ ...evidenceFixtureMe, features: [] }).read).toBe(
    false,
  );
  expect(
    evidencePermissions({
      ...evidenceFixtureMe,
      capabilities: ["evidence.read"],
    }).upload,
  ).toBe(false);
});
