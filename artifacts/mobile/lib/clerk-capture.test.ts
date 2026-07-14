import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLERK_STATUS_META,
  clerkStatusMeta,
  fieldLabel,
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

test("fieldLabel spaces camelCase and capitalizes the first word only", () => {
  assert.equal(fieldLabel("invoiceNumber"), "Invoice number");
  assert.equal(fieldLabel("issueDate"), "Issue date");
  assert.equal(fieldLabel("currency"), "Currency");
  assert.equal(fieldLabel("buyerTaxId"), "Buyer tax id");
  assert.equal(fieldLabel(""), "");
});
