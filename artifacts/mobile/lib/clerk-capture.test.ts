import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base64ByteLength,
  buildCameraCaseInput,
  CAMERA_EMPTY_MESSAGE,
  CAMERA_RETAKE_MESSAGE,
  cameraPhotoName,
  CLERK_STATUS_META,
  clerkStatusMeta,
  fieldLabel,
  MAX_FILE_BYTES,
  pickSourceType,
} from "./clerk-capture.ts";

// The pure mapping logic behind the "Send to Clerk" screen: which badge a
// case status wears, and whether a picked document goes up as a pdf or an
// image case (the server extracts text from pdfs and vision-reads images, so
// a wrong pick means a failed or garbage extraction).

test("every case status maps to a badge, with review-flow wording", () => {
  assert.deepEqual(CLERK_STATUS_META.pending, {
    tone: "neutral",
    label: "Reading…",
  });
  assert.deepEqual(CLERK_STATUS_META.extracted, {
    tone: "info",
    label: "Waiting for review",
  });
  assert.deepEqual(CLERK_STATUS_META.in_review, {
    tone: "info",
    label: "In review",
  });
  assert.deepEqual(CLERK_STATUS_META.approved, {
    tone: "success",
    label: "Approved",
  });
  assert.deepEqual(CLERK_STATUS_META.rejected, {
    tone: "critical",
    label: "Rejected",
  });
  assert.deepEqual(CLERK_STATUS_META.escalated, {
    tone: "warning",
    label: "Escalated",
  });
  assert.deepEqual(CLERK_STATUS_META.failed, {
    tone: "critical",
    label: "Needs input",
  });
});

test("clerkStatusMeta tolerates a status this build doesn't know", () => {
  assert.deepEqual(clerkStatusMeta("pending"), CLERK_STATUS_META.pending);
  assert.deepEqual(clerkStatusMeta("archived"), {
    tone: "neutral",
    label: "Unknown",
  });
  assert.deepEqual(clerkStatusMeta(""), { tone: "neutral", label: "Unknown" });
});

test("pickSourceType trusts a specific mime type over the filename", () => {
  assert.equal(pickSourceType("scan.pdf", "application/pdf"), "pdf");
  assert.equal(pickSourceType("photo.jpg", "image/jpeg"), "image");
  // A mislabelled extension loses to the declared mime.
  assert.equal(pickSourceType("export.pdf", "image/png"), "image");
  assert.equal(pickSourceType("shot.png", "application/pdf"), "pdf");
});

test("pickSourceType falls back to the extension for generic mimes", () => {
  // Android pickers commonly report octet-stream for anything.
  assert.equal(
    pickSourceType("invoice.pdf", "application/octet-stream"),
    "pdf",
  );
  assert.equal(pickSourceType("INVOICE.PDF"), "pdf");
  assert.equal(pickSourceType("receipt.heic"), "image");
  assert.equal(pickSourceType("receipt.JPEG", ""), "image");
  assert.equal(pickSourceType(" photo.webp ", undefined), "image");
});

test("pickSourceType defaults ambiguous picks to image", () => {
  assert.equal(pickSourceType("capture"), "image");
  assert.equal(pickSourceType("", "application/octet-stream"), "image");
});

// The camera path ("Snap it"): what the picker hands back must become the
// exact same image-case submission a picked photo file produces, with the
// oversize guard applied to the bytes the server would actually receive.

test("base64ByteLength reports the decoded size, padded or not", () => {
  assert.equal(base64ByteLength(""), 0);
  assert.equal(base64ByteLength("   "), 0);
  // "A" → "QQ==": 1 byte, two padding chars.
  assert.equal(base64ByteLength(Buffer.from("A").toString("base64")), 1);
  // Some Android encoders omit the padding.
  assert.equal(base64ByteLength("QQ"), 1);
  assert.equal(base64ByteLength(Buffer.from("AB").toString("base64")), 2);
  assert.equal(base64ByteLength(Buffer.from("ABC").toString("base64")), 3);
  const bytes = 12_345;
  assert.equal(
    base64ByteLength(Buffer.alloc(bytes).toString("base64")),
    bytes,
  );
});

test("cameraPhotoName is deterministic UTC for an injected timestamp", () => {
  const at = new Date("2026-07-19T14:32:05.123Z");
  assert.equal(cameraPhotoName(at), "photo-20260719-143205.jpg");
  // Same instant, same name — no hidden clock or randomness.
  assert.equal(cameraPhotoName(at), cameraPhotoName(new Date(at.getTime())));
  assert.equal(
    cameraPhotoName(new Date("2026-01-02T03:04:05Z")),
    "photo-20260102-030405.jpg",
  );
});

test("buildCameraCaseInput assembles the picked-photo submission shape", () => {
  const b64 = Buffer.from("fake jpeg bytes").toString("base64");
  const built = buildCameraCaseInput(b64, new Date("2026-07-19T09:00:00Z"));
  assert.ok(built.ok);
  assert.deepEqual(built.input, {
    sourceType: "image",
    name: "photo-20260719-090000.jpg",
    contentType: "image/jpeg",
    imageBase64: b64,
  });
});

test("buildCameraCaseInput accepts exactly 5 MB and refuses one byte more", () => {
  const at = new Date("2026-07-19T09:00:00Z");
  const atLimit = buildCameraCaseInput(
    Buffer.alloc(MAX_FILE_BYTES).toString("base64"),
    at,
  );
  assert.equal(atLimit.ok, true);
  const over = buildCameraCaseInput(
    Buffer.alloc(MAX_FILE_BYTES + 1).toString("base64"),
    at,
  );
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.message, CAMERA_RETAKE_MESSAGE);
});

test("buildCameraCaseInput refuses an empty capture with its own copy", () => {
  const refused = buildCameraCaseInput("", new Date());
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.message, CAMERA_EMPTY_MESSAGE);
});

test("fieldLabel spaces camelCase and capitalizes the first word only", () => {
  assert.equal(fieldLabel("invoiceNumber"), "Invoice number");
  assert.equal(fieldLabel("issueDate"), "Issue date");
  assert.equal(fieldLabel("currency"), "Currency");
  assert.equal(fieldLabel("buyerTaxId"), "Buyer tax id");
  assert.equal(fieldLabel(""), "");
});
