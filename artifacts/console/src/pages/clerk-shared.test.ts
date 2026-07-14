import { test, expect, describe } from "vitest";
import type {
  ClerkCase,
  ClerkExtractionField,
} from "@workspace/api-client-react";
import { isReadyToApprove } from "./clerk-shared";

function field(patch: Partial<ClerkExtractionField>): ClerkExtractionField {
  return {
    field: "invoiceNumber",
    value: "INV-001",
    confidence: 0.97,
    sourceSnippet: null,
    critical: false,
    flagged: false,
    ...patch,
  };
}

function makeCase(patch: Partial<ClerkCase>): ClerkCase {
  return {
    id: "case-1",
    kind: "extraction",
    status: "extracted",
    createdBy: "op-1",
    createdAt: "2026-07-01T10:00:00Z",
    updatedAt: "2026-07-01T10:00:00Z",
    preflight: [],
    extraction: {
      fields: [
        field({ field: "invoiceNumber", critical: true }),
        field({ field: "issueDate", value: "2026-06-30", critical: true }),
        field({ field: "dueDate", value: null, confidence: 0.4 }),
      ],
      lines: [],
      promptVersion: "v1",
      model: "test-model",
    },
    ...patch,
  };
}

describe("isReadyToApprove", () => {
  test("ready: extracted, empty pre-flight, criticals confident and present", () => {
    expect(isReadyToApprove(makeCase({}))).toBe(true);
  });

  test("not ready when preflight is null or undefined — never ran is not clear", () => {
    expect(isReadyToApprove(makeCase({ preflight: null }))).toBe(false);
    expect(isReadyToApprove(makeCase({ preflight: undefined }))).toBe(false);
  });

  test("not ready while pre-flight lists issues", () => {
    expect(
      isReadyToApprove(
        makeCase({
          preflight: [{ field: "issueDate", message: "Issue date is in the future" }],
        }),
      ),
    ).toBe(false);
  });

  test("not ready when a critical field has no value", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, value: null })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(false);
  });

  test("not ready when a critical field's confidence is below 0.9", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, confidence: 0.89 })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(false);
    // The boundary itself passes: >= 0.9, not > 0.9.
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [field({ critical: true, confidence: 0.9 })],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(true);
  });

  test("a shaky NON-critical field does not block readiness", () => {
    expect(
      isReadyToApprove(
        makeCase({
          extraction: {
            fields: [
              field({ critical: true }),
              field({ field: "dueDate", value: null, confidence: 0.1 }),
            ],
            lines: [],
            promptVersion: "v1",
            model: "test-model",
          },
        }),
      ),
    ).toBe(true);
  });

  test("only status 'extracted' qualifies", () => {
    expect(isReadyToApprove(makeCase({ status: "in_review" }))).toBe(false);
    expect(isReadyToApprove(makeCase({ status: "pending" }))).toBe(false);
    expect(isReadyToApprove(makeCase({ status: "approved" }))).toBe(false);
  });
});
